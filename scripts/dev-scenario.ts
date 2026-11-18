import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { ConfigProblem } from "../src/contracts/index.ts";
import { Engine } from "../src/engine/engine.ts";
import { writeRuntimeRecord } from "../src/engine/instance.ts";
import { fakeMcpServer, weatherTool } from "../src/extensions/mcp/testing.ts";
import { MemoryRepo } from "../src/extensions/memory/index.ts";
import { FileCredentialStore } from "../src/models/auth-store.ts";
import { applyModelsConfig, loadModelsConfig } from "../src/models/models-config.ts";
import { Auth } from "../src/server/auth.ts";
import { createHttpServer } from "../src/server/http.ts";
import { createRoutes } from "../src/server/routes.ts";
import { attachStream } from "../src/server/stream.ts";
import { configIssue } from "../src/shared/config.ts";
import { uiDir, version } from "../src/shared/package.ts";
import { eeveePaths } from "../src/shared/paths.ts";
import { DEFAULT_SETTINGS, type Settings, SettingsStore } from "../src/shared/settings.ts";

const say = (text: string) => fauxAssistantMessage(fauxText(text));

const call = (name: string, args: JsonObject) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

const calls = (items: { name: string; args: JsonObject }[]) =>
  fauxAssistantMessage(
    items.map((item) => fauxToolCall(item.name, item.args)),
    { stopReason: "toolUse" },
  );

function textOf(message: Message | undefined): string {
  if (message === undefined) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: { text?: string }) => part.text ?? "").join("");
}

function toolName(message: Message | undefined): string | undefined {
  return message?.role === "toolResult" ? message.toolName : undefined;
}

async function until<T>(
  probe: () => Promise<T | undefined | false>,
  label: string,
  timeoutMs = 25_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined && value !== false) return value as T;
    await sleep(30);
  }
  throw new Error(`场景等待超时：${label}`);
}

function listen(server: Server, preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code !== "EADDRINUSE") return reject(error);
      server.listen(0, "127.0.0.1");
    };
    server.on("error", onError);
    server.on("listening", () => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : preferred);
    });
    server.listen(preferred, "127.0.0.1");
  });
}

const checkOnly = process.argv.includes("--check");
const ownHome = process.env.EEVEE_HOME === undefined;
const home = process.env.EEVEE_HOME ?? (await mkdtemp(join(tmpdir(), "eevee-dev-")));
const paths = eeveePaths(home);

process.env.GIT_AUTHOR_NAME ??= "eevee-dev";
process.env.GIT_COMMITTER_NAME ??= "eevee-dev";
process.env.GIT_AUTHOR_EMAIL ??= "eevee@dev.invalid";
process.env.GIT_COMMITTER_EMAIL ??= "eevee@dev.invalid";

await mkdir(paths.extensions, { recursive: true });
await writeFile(
  join(paths.extensions, "notes.mjs"),
  `export default {
  name: "notes",
  tools: [
    {
      name: "note_search",
      description: "在实验笔记里按关键词检索",
      parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      async execute(args) { return { output: [{ type: "text", text: "找到 3 条关于 " + args.q + " 的记录" }] }; },
    },
  ],
};\n`,
);
await writeFile(paths.mcp, JSON.stringify({ mcpServers: { weather: { command: "unused" } } }));
await writeFile(
  paths.modelProfiles,
  [
    "# 模型目录说明",
    "",
    "- `faux/sonnet-faux`：日常调度与多轮对话（性价比均衡）",
    "- `faux/opus-faux`：复杂论文推导、重构与仿真分析",
    "- `faux/haiku-faux`：轻量整理记忆与摘要",
  ].join("\n"),
);

const initialSettings: Settings = {
  ...DEFAULT_SETTINGS,
  models: {
    default: { provider: "faux", modelId: "sonnet-faux" },
    router: { provider: "faux", modelId: "sonnet-faux" },
    worker: { provider: "faux", modelId: "opus-faux", thinkingLevel: "high" },
    dreamer: { provider: "faux", modelId: "haiku-faux" },
  },
  maxActiveWorkers: 4,
  backgroundAfterMs: 300_000,
  dreamIntervalMs: 0,
  roles: {
    router: { extensions: ["notes"] },
    worker: { extensions: ["notes", "mcp.weather"], maxTurns: 25 },
  },
};
await mkdir(paths.home, { recursive: true });
await writeFile(paths.settings, JSON.stringify(initialSettings, null, 2));

const faux = fauxProvider({
  provider: "faux",
  tokensPerSecond: checkOnly ? 2000 : 60,
  models: [
    {
      id: "sonnet-faux",
      name: "Sonnet Faux",
      reasoning: true,
      contextWindow: 200_000,
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    },
    {
      id: "opus-faux",
      name: "Opus Faux",
      reasoning: true,
      contextWindow: 200_000,
      cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    },
    {
      id: "haiku-faux",
      name: "Haiku Faux",
      contextWindow: 200_000,
      cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
    },
  ],
});

let seeded = false;
let failedT7Once = false;
let failedP2Once = false;
let askedT4 = false;

const brain: FauxResponseFactory = (context) => {
  const messages = context.messages;
  const serialized = JSON.stringify(messages.filter((m) => m.role !== "toolResult"));
  const last = messages.findLast((m) => m.role !== "system");
  const lastText = textOf(last);
  const role = serialized.includes("你是 Eevee 的调度者")
    ? "router"
    : serialized.includes("你负责整理项目的记忆库")
      ? "dreamer"
      : "worker";

  if (role === "router") {
    if (serialized.includes("Eevee 面板联调")) {
      if (!failedP2Once) {
        failedP2Once = true;
        throw new Error("403 forbidden: simulated router failure");
      }
      return say("已从失败恢复：流协议重连与缺口补全检查就绪，需要我开单吗？");
    }

    if (last?.role === "user" && lastText.includes("「搭建论文模板与目录结构」报告 · ready")) {
      return call("ticket", {
        action: "review",
        ticketId: "t1",
        verdict: "accept",
        note: "main.tex 与第 3 章结构完整",
      });
    }
    if (toolName(last) === "ticket" && lastText.includes("t1 已验收结单")) {
      return say("模板已经搭好并验收结单（**t1**）。接下来可以继续推进仿真和文献。");
    }
    if (last?.role === "user" && lastText.includes("先搭建论文模板")) {
      return call("read", { path: "chapters/03-sim.tex" });
    }
    if (
      toolName(last) === "read" &&
      !messages.some(
        (m) => m.role === "assistant" && JSON.stringify(m.content).includes('"ticket"'),
      )
    ) {
      return call("ticket", {
        action: "create",
        title: "搭建论文模板与目录结构",
        goal: "创建 main.tex 主模板并梳理第 3 章结构",
        inputs: ["chapters/03-sim.tex"],
        acceptance: ["生成 main.tex", "更新第 3 章小节标题"],
        output: "main.tex",
      });
    }

    if (last?.role === "user" && lastText.includes("请并行推进仿真扫描")) {
      return calls([
        {
          name: "ask_user",
          args: {
            items: [
              {
                text: "目标投稿期刊样式按哪个模板导出？",
                options: ["ACS Photonics（双栏）", "Optica（单栏草稿）"],
                recommended: "ACS Photonics（双栏）",
              },
              {
                text: "主图配色是否全部切换为 Okabe-Ito 色盲友好调色板？",
                options: ["是，全部切换", "保留 legacy 目录原配色"],
                recommended: "是，全部切换",
              },
            ],
          },
        },
        {
          name: "ticket",
          args: {
            action: "create",
            title: "多角度 FDTD 扫描仿真",
            goal: "运行 0°–60° 入射角偏振扫描并输出误差统计",
            inputs: ["sim/run.mjs"],
            acceptance: ["13 个角度全部收敛", "能量守恒误差 < 1%"],
            output: "sim/out/",
          },
        },
        {
          name: "ticket",
          args: {
            action: "create",
            title: "补充 2023–2026 年对比实验数据",
            goal: "接入基线测量 CSV 并生成对比表",
            inputs: ["data/baseline.csv"],
            acceptance: ["表 2 数值核对通过"],
          },
        },
        {
          name: "ticket",
          args: {
            action: "create",
            title: "统一参考文献样式（ACS）",
            goal: "补全 refs.bib 的 DOI 与期刊缩写",
            inputs: ["refs.bib"],
            acceptance: ["bibtex 编译无警告"],
            output: "refs.bib",
          },
        },
        {
          name: "ticket",
          args: {
            action: "create",
            title: "重绘偏振对比图",
            goal: "核对参考文献中的对比曲线并刷新脚本",
            inputs: ["refs.bib", "sim/run.mjs"],
            acceptance: ["曲线与标注核对一致"],
            output: "figs/polar-compare.pdf",
          },
        },
        {
          name: "ticket",
          args: {
            action: "create",
            title: "撰写引言与仿真分析草稿",
            goal: "补齐第 3 章仿真分析段落并持续校验公式引用",
            inputs: ["chapters/03-sim.tex"],
            acceptance: ["第 3 章结构与公式编号完整"],
            output: "chapters/03-sim.tex",
          },
        },
        {
          name: "ticket",
          args: {
            action: "create",
            title: "导出高分辨率矢量插图",
            goal: "批量导出提交版本 PDF/SVG 插图",
            inputs: ["chapters/03-sim.tex"],
            acceptance: ["字体嵌入检查通过"],
            provider: "faux",
            modelId: "sonnet-faux",
            modelReason: "脚本导出只需轻量模型",
          },
        },
      ]);
    }

    if (
      last?.role === "user" &&
      lastText.includes("「统一参考文献样式（ACS）」报告 · waiting") &&
      !askedT4
    ) {
      askedT4 = true;
      return call("ask_user", {
        ticketId: "t4",
        items: [
          {
            text: "refs.bib 中有 9 条文献缺少标准期刊缩写，怎么处理？",
            options: ["按 ISO4 规则自动生成", "先保留全称并标出待补清单"],
            recommended: "按 ISO4 规则自动生成",
          },
        ],
      });
    }

    if (
      last?.role === "user" &&
      lastText.includes("「补充 2023–2026 年对比实验数据」报告 · blocked")
    ) {
      return say("收到 **t3** 的受阻报告，等确认数据源后再安排继续。");
    }
    if (last?.role === "user" && lastText.includes("「重绘偏振对比图」报告 · ready")) {
      return say("**t5** 已提交完成报告，待验收。");
    }
    if (last?.role === "user" && lastText.includes("「导出高分辨率矢量插图」报告 · failed")) {
      return say("**t7** 在本轮调用模型时遇到配额限制失败，待处理或重试。");
    }
    if (seeded && last?.role === "user") {
      return say(`收到：${lastText.slice(0, 120)}。我可以继续调整工单、验收报告或补充问题。`);
    }
    return say("好的，已将任务拆成工单并在后台并行推进，有需要你拍板的地方再通知你。");
  }

  // Worker / Dreamer turns
  const opening = textOf(messages.find((m) => m.role === "user" && textOf(m).includes("<ticket>")));

  if (opening.includes("搭建论文模板与目录结构")) {
    if (last?.role === "user") {
      return call("write", {
        path: "main.tex",
        content:
          "\\documentclass{article}\n\\begin{document}\n\\input{chapters/03-sim}\n\\end{document}\n",
      });
    }
    if (toolName(last) === "write") {
      return call("edit", {
        path: "chapters/03-sim.tex",
        edits: [
          {
            oldText: "\\section{Simulation}",
            newText: "\\section{FDTD Polarization Simulation}",
          },
        ],
      });
    }
    if (toolName(last) === "edit") {
      return call("report", {
        status: "ready",
        summary: "已搭建 main.tex 与第 3 章框架",
        artifacts: [
          { path: "main.tex", note: "论文主模板" },
          { path: "chapters/03-sim.tex", note: "更新章节标题" },
        ],
        lessons: ["第 3 章标题统一使用 FDTD Polarization Simulation"],
      });
    }
    return say("模板任务已完成。");
  }

  if (opening.includes("多角度 FDTD 扫描仿真")) {
    if (last?.role === "user" && !lastText.includes("后台作业")) {
      return call("bash", { command: "node sim/run.mjs", background: true });
    }
    if (toolName(last) === "bash") {
      return say("FDTD 多角度扫描已转入后台作业，完成后会自动唤醒我提交报告。");
    }
    if (last?.role === "user" && lastText.includes("后台作业")) {
      return call("report", {
        status: "ready",
        summary: "13 个角度仿真已全部完成",
        artifacts: [{ path: "sim/out/", note: "扫描输出目录" }],
      });
    }
    return say("等待后台作业结果。");
  }

  if (opening.includes("补充 2023–2026 年对比实验数据")) {
    if (last?.role === "user" && !seeded) {
      return call("report", {
        status: "blocked",
        summary: "工作区缺少 data/baseline.csv，无法生成对比实验表",
        need: "请提供 data/baseline.csv 或指定改用公开数据集",
        artifacts: [],
      });
    }
    return say("收到指示，继续处理对比数据。");
  }

  if (opening.includes("统一参考文献样式（ACS）")) {
    if (last?.role === "user" && lastText.includes("用户回答了问题")) {
      return call("report", {
        status: "ready",
        summary: `已按用户选择（${lastText.split("\n").slice(1).join(" ")}）更新 refs.bib`,
        artifacts: [{ path: "refs.bib", note: "ACS 样式文献库" }],
      });
    }
    if (last?.role === "user") {
      return call("report", {
        status: "waiting",
        summary: "refs.bib 有 9 条文献缺少标准期刊缩写，需要确认处理规则",
        need: "确认是否按 ISO4 自动生成期刊缩写",
        artifacts: [],
      });
    }
    return say("等待文献规则确认。");
  }

  if (opening.includes("重绘偏振对比图")) {
    if (last?.role === "user") {
      return call("read", { path: "refs.bib" });
    }
    if (toolName(last) === "read") {
      return call("report", {
        status: "ready",
        summary: "已核对 12 条文献基线参数并更新绘图脚本",
        artifacts: [{ path: "sim/run.mjs", note: "偏振对比脚本" }],
      });
    }
    return say("等待 Router 验收。");
  }

  if (opening.includes("撰写引言与仿真分析草稿")) {
    if (last?.role === "user" && !seeded) {
      return call("edit", {
        path: "chapters/03-sim.tex",
        edits: [
          {
            oldText: "% TODO: add convergence analysis",
            newText: "The PML boundary uses 12 layers for incidence angles above 45 degrees.",
          },
        ],
      });
    }
    if (toolName(last) === "edit") {
      return call("bash", { command: "node sim/draft-watch.mjs" });
    }
    return say(`草稿校验已更新（最新输入：${lastText.slice(0, 60)}）。`);
  }

  if (opening.includes("导出高分辨率矢量插图")) {
    if (!failedT7Once) {
      failedT7Once = true;
      throw new Error("403 forbidden: model quota exceeded");
    }
    return call("report", {
      status: "ready",
      summary: "重试成功，已导出高分辨率矢量插图",
      artifacts: [{ path: "figs/overview.svg", note: "矢量插图" }],
    });
  }

  return say("收到。");
};

// Once seeded, every answer takes a moment as a real model's would, so the panel's running state
// (the thinking line, steer / queue, stop) can be seen and tried. Stopping cuts the wait short.
const THINK_MS = checkOnly ? 0 : 5_000;

const factory: FauxResponseFactory = async (context, streamOptions, state, model) => {
  if (faux.getPendingResponseCount() < 16) {
    faux.appendResponses(Array.from({ length: 32 }, () => factory));
  }
  if (seeded && THINK_MS > 0) {
    await sleep(THINK_MS, undefined, { signal: streamOptions?.signal }).catch(() => {});
  }
  return brain(context, streamOptions, state, model);
};
faux.setResponses(Array.from({ length: 48 }, () => factory));

const credentials = new FileCredentialStore(paths.auth);
const buildModels = async () => {
  const models = createModels();
  models.setProvider(faux.provider);
  const problems: ConfigProblem[] = [];
  const custom = new Set<string>();
  try {
    problems.push(...applyModelsConfig(models, await loadModelsConfig(paths.models), custom));
  } catch (error) {
    problems.push({ ...configIssue(error), file: "models.json" });
  }
  return { models, custom, problems };
};
let modelState = await buildModels();
const models = {
  models: () => modelState.models,
  credentials,
  customProviders: () => modelState.custom,
  problems: () => modelState.problems,
  async reload() {
    modelState = await buildModels();
  },
};

const mcpServer = fakeMcpServer([weatherTool]);
const store = await SettingsStore.open(paths.settings);
const engine = await Engine.open({
  paths,
  settings: store,
  models,
  context: BACKGROUND_CONTEXT,
  client: { name: "eevee-dev", version },
  openMcp: () => mcpServer.client,
});

// Seed global memory
const globalRepo = new MemoryRepo(paths.globalMemory);
await globalRepo.ensure("# 全局记忆\n");
await globalRepo.edit(
  "MEMORY.md",
  "# 全局记忆\n",
  "# 全局记忆\n\n- 偏好中文回复，单位与数字之间保留空格\n",
  "seed-global",
);
await globalRepo.commitRound("seed-global", "memory");

// Create Project 1: optics
const ws1 = join(home, "workspaces", "optics");
await mkdir(join(ws1, "chapters"), { recursive: true });
await mkdir(join(ws1, "sim"), { recursive: true });
await writeFile(
  join(ws1, "chapters", "03-sim.tex"),
  "\\section{Simulation}\n% TODO: add convergence analysis\nWe evaluate metasurface polarization response across 0--60 degrees.\n",
);
await writeFile(
  join(ws1, "refs.bib"),
  "@article{chen2025,\n  title={Metasurface Polarimetry},\n  author={Chen, Lin},\n  year={2025}\n}\n",
);
await writeFile(
  join(ws1, "sim", "run.mjs"),
  `let step = 1;
const total = ${checkOnly ? 3 : 90};
const interval = ${checkOnly ? 1500 : 2000};
console.log("[fdtd] initializing 13 incidence angles...");
const timer = setInterval(() => {
  console.log(\`[fdtd] angle=\${(step - 1) * 5}° step \${step}/\${total} err=0.24%\`);
  step += 1;
  if (step > total) clearInterval(timer);
}, interval);
`,
);
await writeFile(
  join(ws1, "sim", "draft-watch.mjs"),
  `let n = 1;
console.log("[draft] checking LaTeX equations and figure refs...");
const timer = setInterval(() => {
  console.log(\`[draft] pass \${n}: chapters/03-sim.tex ok\`);
  n += 1;
  if (n > ${checkOnly ? 60 : 600}) clearInterval(timer);
}, 3000);
`,
);

const p1 = await engine.createProject({ title: "光学论文《超表面偏振成像》", workspace: ws1 });
const host1 = engine.project(p1.id);
if (!host1) throw new Error(`找不到项目 ${p1.id}`);

const p1Repo = new MemoryRepo(paths.project(p1.id).memory);
await p1Repo.create(
  "optics-sim.md",
  "## FDTD 仿真\n- 网格默认 λ/15\n- > 45° 需加厚 PML 到 12 层\n",
  "seed-p1",
);
await p1Repo.commitRound("seed-p1", "dreaming t0");
await p1Repo.create(
  "writing-style.md",
  "# 写作偏好\n- 每段先给结论，再给证据\n- 少用被动语态\n",
  "seed-p1-2",
);
await p1Repo.commitRound("seed-p1-2", "memory");

// Round 1 on p1: t1 created & accepted
await host1.sendUserMessage("先搭建论文模板，然后验收结单。");
await until(async () => {
  const board = await host1.board();
  const conv = await host1.conversation();
  return board.tickets.find((t) => t.ticket.id === "t1")?.ticket.status === "done" && !conv.running;
}, "t1 验收结单");

// Round 2 on p1: t2 (jobs), t3 (blocked), t4 (answer), t5 (review), t6 (working), t7 (failed) + q1
await host1.sendUserMessage(
  "请并行推进仿真扫描、对比实验数据、文献样式整理、图表重绘、引言撰写与矢量图导出。",
);
await until(async () => {
  const board = await host1.board();
  const byId = new Map(board.tickets.map((t) => [t.ticket.id, t]));
  const conv = await host1.conversation();
  return (
    board.openQuestions.length >= 2 &&
    byId.get("t2")?.stage === "jobs" &&
    byId.get("t3")?.stage === "blocked" &&
    byId.get("t4")?.stage === "answer" &&
    byId.get("t5")?.stage === "review" &&
    byId.get("t6")?.stage === "working" &&
    byId.get("t7")?.reports.some((r) => r.status === "failed") &&
    !conv.running &&
    board
  );
}, "p1 全部工单进入目标状态");

// Leave an uncommitted manual edit in project memory
await writeFile(
  join(paths.project(p1.id).memory, "writing-style.md"),
  "# 写作偏好\n- 每段先给结论，再给证据\n- 少用被动语态\n- 图例放在图内右上角（本地未提交手改）\n",
);

// Project 2: Router failure state
const ws2 = join(home, "workspaces", "eevee-demo");
await mkdir(ws2, { recursive: true });
const p2 = await engine.createProject({ title: "Eevee 面板联调", workspace: ws2 });
const host2 = engine.project(p2.id);
if (!host2) throw new Error(`找不到项目 ${p2.id}`);
await host2.sendUserMessage("检查流协议重连与契约边界");
await until(async () => {
  const conv = await host2.conversation();
  return !conv.running && conv.failure !== undefined;
}, "p2 Router 失败状态");

// Project 3: Empty project
const ws3 = join(home, "workspaces", "empty");
await mkdir(ws3, { recursive: true });
await engine.createProject({ title: "空白实验记录", workspace: ws3 });

seeded = true;

if (checkOnly) {
  const board1 = await host1.board();
  const conv2 = await host2.conversation();
  const diff1 = await host1.memoryDiff("project");
  console.log("场景自检通过：", {
    projects: engine.projects().map((p) => p.title),
    p1Stages: board1.tickets.map((t) => `${t.ticket.id}:${t.stage}`),
    openQuestions: board1.openQuestions.map((q) => `${q.id}${q.ticketId ? `->${q.ticketId}` : ""}`),
    p2Failure: conv2.failure,
    hasUncommittedMemoryDiff: diff1.includes("本地未提交手改"),
  });
  await engine.close();
  await mcpServer.server.close();
  if (ownHome) await rm(home, { recursive: true, force: true, maxRetries: 5 });
  process.exit(0);
}

const auth = await Auth.open({
  cliTokenPath: paths.runtime.cliToken,
  sessionsPath: paths.runtime.sessions,
});

let port = Number(process.env.EEVEE_PORT ?? initialSettings.port);
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await stream.close();
  server.close();
  await engine.close();
  await mcpServer.server.close();
  if (ownHome)
    await rm(home, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  process.exit(0);
};

const server = createHttpServer({
  routes: createRoutes({
    engine,
    auth,
    port: () => port,
    version: `${version}-dev`,
    shutdown: () => void shutdown(),
  }),
  auth,
  uiDir: uiDir(),
});
const stream = attachStream(server, { source: engine, auth });
port = await listen(server, port);
await writeRuntimeRecord(paths.runtime.record, {
  pid: process.pid,
  port,
  bootId: engine.bootId,
  startedAt: Date.now(),
});

const codeUi = auth.issueCode();
const codeVite = auth.issueCode();
console.log("");
console.log(`Eevee 开发场景 Engine 已启动（port ${port}，EEVEE_HOME=${home}）`);
console.log(
  `  已建项目：${engine
    .projects()
    .map((p) => `${p.id}「${p.title}」`)
    .join(" / ")}`,
);
console.log(`  内置界面：http://127.0.0.1:${port}/ui/#code=${encodeURIComponent(codeUi)}`);
console.log(`  Vite开发：http://127.0.0.1:5173/ui/#code=${encodeURIComponent(codeVite)}`);
console.log("  按 Ctrl+C 停止并清理临时目录。");

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
