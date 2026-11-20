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
  fauxThinking,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
import { Engine } from "../src/engine/engine.ts";
import { writeRuntimeRecord } from "../src/engine/instance.ts";
import { fakeMcpServer, weatherTool } from "../src/extensions/mcp/testing.ts";
import { MemoryRepo } from "../src/extensions/memory/index.ts";
import { createModelRuntime } from "../src/models/index.ts";
import { Auth } from "../src/server/auth.ts";
import { createHttpServer } from "../src/server/http.ts";
import { createRoutes } from "../src/server/routes.ts";
import { attachStream } from "../src/server/stream.ts";
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

const thinkCall = (thinking: string, name: string, args: JsonObject) =>
  fauxAssistantMessage([fauxThinking(thinking), fauxToolCall(name, args)], {
    stopReason: "toolUse",
  });

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
  throw new Error(`Timed out waiting for the scenario: ${label}`);
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

await writeFile(paths.mcp, JSON.stringify({ mcpServers: { weather: { command: "unused" } } }));
await writeFile(
  paths.modelProfiles,
  [
    "# Model catalog notes",
    "",
    "- `faux/sonnet-faux`: everyday dispatch and multi-turn chat (balanced cost)",
    "- `faux/opus-faux`: complex paper derivation, refactoring and simulation analysis",
    "- `faux/haiku-faux`: lightweight memory tidy-up and summaries",
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
  dreaming: { ...DEFAULT_SETTINGS.dreaming, enabled: false },
  roles: {
    worker: { extensions: ["mcp.weather", "mcp.gone"], maxTurns: 25 },
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
  const role = serialized.includes("You are Eevee's Router")
    ? "router"
    : serialized.includes("You keep the project's memory store")
      ? "dreamer"
      : "worker";

  if (role === "router") {
    if (serialized.includes("Eevee panel integration")) {
      if (!failedP2Once) {
        failedP2Once = true;
        throw new Error("403 forbidden: simulated router failure");
      }
      return say(
        "Recovered from the failure: the stream reconnection and gap backfill checks are ready. Shall I open a ticket?",
      );
    }

    if (
      last?.role === "user" &&
      lastText.includes("“Build the paper template and directory structure” report · ready")
    ) {
      return call("ticket", {
        action: "review",
        ticketId: "t1",
        verdict: "accept",
        note: "main.tex and the chapter 3 structure are complete",
      });
    }
    if (toolName(last) === "ticket" && lastText.includes("t1 is accepted and closed")) {
      return say(
        "The template is in place and **t1** is accepted and closed. The generated `main.tex` now looks like:\n\n```latex\n\\documentclass{article}\n\\begin{document}\n\\input{chapters/03-sim}\n\\end{document}\n```\n\nNext we can move on to the simulation and the references.",
      );
    }
    if (last?.role === "user" && lastText.includes("First build the paper template")) {
      return thinkCall(
        "The chapter file tells me what the template has to cover before I split this into tickets.",
        "read",
        { path: "chapters/03-sim.tex" },
      );
    }
    if (
      toolName(last) === "read" &&
      !messages.some(
        (m) => m.role === "assistant" && JSON.stringify(m.content).includes('"ticket"'),
      )
    ) {
      return call("ticket", {
        action: "create",
        title: "Build the paper template and directory structure",
        goal: "Create the main.tex master template and sort out the chapter 3 structure",
        inputs: ["chapters/03-sim.tex"],
        acceptance: ["main.tex is generated", "the chapter 3 subsection titles are updated"],
        output: "main.tex",
      });
    }

    if (last?.role === "user" && lastText.includes("Please push the simulation scan")) {
      return calls([
        {
          name: "ask_user",
          args: {
            items: [
              {
                text: "Which template should the target journal style export use?",
                options: ["ACS Photonics (two-column)", "Optica (single-column draft)"],
                recommended: "ACS Photonics (two-column)",
              },
              {
                text: "Should the main figures all switch to the Okabe-Ito colorblind-friendly palette?",
                options: ["Yes, switch all of them", "Keep the legacy directory's colors"],
                recommended: "Yes, switch all of them",
              },
            ],
          },
        },
        {
          name: "ticket",
          args: {
            action: "create",
            title: "Multi-angle FDTD scan simulation",
            goal: "Run the 0°–60° incidence angle polarization scan and output the error statistics",
            inputs: ["sim/run.mjs"],
            acceptance: ["all 13 angles converge", "the energy conservation error stays under 1%"],
            output: "sim/out/",
          },
        },
        {
          name: "ticket",
          args: {
            action: "create",
            title: "Add 2023–2026 comparison experiment data",
            goal: "Wire in the baseline measurement CSV and generate the comparison table",
            inputs: ["data/baseline.csv"],
            acceptance: ["the table 2 numbers check out"],
          },
        },
        {
          name: "ticket",
          args: {
            action: "create",
            title: "Unify the reference style (ACS)",
            goal: "Fill in the DOIs and journal abbreviations in refs.bib",
            inputs: ["refs.bib"],
            acceptance: ["bibtex compiles without warnings"],
            output: "refs.bib",
          },
        },
        {
          name: "ticket",
          args: {
            action: "create",
            title: "Redraw the polarization comparison figure",
            goal: "Check the comparison curves against the references and refresh the script",
            inputs: ["refs.bib", "sim/run.mjs"],
            acceptance: ["the curves and their labels agree"],
            output: "figs/polar-compare.pdf",
          },
        },
        {
          name: "ticket",
          args: {
            action: "create",
            title: "Draft the introduction and the simulation analysis",
            goal: "Fill in the chapter 3 simulation analysis paragraphs and keep checking the formula references",
            inputs: ["chapters/03-sim.tex"],
            acceptance: ["the chapter 3 structure and formula numbering are complete"],
            output: "chapters/03-sim.tex",
          },
        },
        {
          name: "ticket",
          args: {
            action: "create",
            title: "Export high-resolution vector figures",
            goal: "Batch export the submission version's PDF/SVG figures",
            inputs: ["chapters/03-sim.tex"],
            acceptance: ["the font embedding check passes"],
            provider: "faux",
            modelId: "sonnet-faux",
            modelReason: "scripted export only needs a light model",
          },
        },
      ]);
    }

    if (
      last?.role === "user" &&
      lastText.includes("“Unify the reference style (ACS)” report · waiting") &&
      !askedT4
    ) {
      askedT4 = true;
      return call("ask_user", {
        ticketId: "t4",
        items: [
          {
            text: "9 references in refs.bib lack standard journal abbreviations; how should we handle them?",
            options: [
              "Generate them automatically with the ISO4 rules",
              "Keep the full names for now and list what is missing",
            ],
            recommended: "Generate them automatically with the ISO4 rules",
          },
        ],
      });
    }

    if (
      last?.role === "user" &&
      lastText.includes("“Add 2023–2026 comparison experiment data” report · blocked")
    ) {
      return say(
        "Got **t3**'s blocked report; we will arrange the rest once the data source is confirmed.",
      );
    }
    if (
      last?.role === "user" &&
      lastText.includes("“Redraw the polarization comparison figure” report · ready")
    ) {
      return say("**t5** handed in a ready report, waiting for review.");
    }
    if (
      last?.role === "user" &&
      lastText.includes("“Export high-resolution vector figures” report · failed")
    ) {
      return say("**t7** failed this round on a model quota limit; it needs handling or a retry.");
    }
    if (seeded && last?.role === "user") {
      return say(
        `Got it: ${lastText.slice(0, 120)}. I can keep adjusting tickets, reviewing reports or asking questions.`,
      );
    }
    return say(
      "Sure, I have split the work into tickets and am pushing them in parallel in the background; I will speak up where a decision is needed.",
    );
  }

  const opening = textOf(messages.find((m) => m.role === "user" && textOf(m).includes("<ticket>")));

  if (opening.includes("Build the paper template and directory structure")) {
    if (last?.role === "user") {
      return thinkCall(
        "main.tex is a thin master file: article class, then the chapter inputs. I will start with chapter 3.",
        "write",
        {
          path: "main.tex",
          content:
            "\\documentclass{article}\n\\begin{document}\n\\input{chapters/03-sim}\n\\end{document}\n",
        },
      );
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
        summary: "main.tex and the chapter 3 skeleton are in place",
        artifacts: [
          { path: "main.tex", note: "the paper's master template" },
          { path: "chapters/03-sim.tex", note: "updated the section title" },
        ],
        lessons: ["chapter 3 titles use FDTD Polarization Simulation throughout"],
      });
    }
    return say("The template task is done.");
  }

  if (opening.includes("Multi-angle FDTD scan simulation")) {
    if (last?.role === "user" && !lastText.includes("Background job")) {
      return call("bash", { command: "node sim/run.mjs", background: true });
    }
    if (toolName(last) === "bash") {
      return say(
        "The multi-angle FDTD scan has moved to a background job; it will wake me to file the report once it ends.",
      );
    }
    if (last?.role === "user" && lastText.includes("Background job")) {
      return call("report", {
        status: "ready",
        summary: "all 13 angles of the simulation are done",
        artifacts: [{ path: "sim/out/", note: "scan output directory" }],
      });
    }
    return say("Waiting for the background job.");
  }

  if (opening.includes("Add 2023–2026 comparison experiment data")) {
    if (last?.role === "user" && !seeded) {
      return call("report", {
        status: "blocked",
        summary:
          "the workspace has no data/baseline.csv, so the comparison table cannot be generated",
        need: "provide data/baseline.csv or name a public dataset to use instead",
        artifacts: [],
      });
    }
    return say("Understood, carrying on with the comparison data.");
  }

  if (opening.includes("Unify the reference style (ACS)")) {
    if (last?.role === "user" && lastText.includes("The user answered question")) {
      return call("report", {
        status: "ready",
        summary: `updated refs.bib with the user's choice (${lastText.split("\n").slice(1).join(" ")})`,
        artifacts: [{ path: "refs.bib", note: "the ACS style bibliography" }],
      });
    }
    if (last?.role === "user") {
      return call("report", {
        status: "waiting",
        summary:
          "9 references in refs.bib lack standard journal abbreviations; the rule needs confirming",
        need: "confirm whether to generate the journal abbreviations with ISO4",
        artifacts: [],
      });
    }
    return say("Waiting for the reference rule to be confirmed.");
  }

  if (opening.includes("Redraw the polarization comparison figure")) {
    if (last?.role === "user") {
      return call("read", { path: "refs.bib" });
    }
    if (toolName(last) === "read") {
      return call("report", {
        status: "ready",
        summary: "checked the baseline parameters of 12 references and updated the plotting script",
        artifacts: [{ path: "sim/run.mjs", note: "the polarization comparison script" }],
      });
    }
    return say("Waiting for the Router's review.");
  }

  if (opening.includes("Draft the introduction and the simulation analysis")) {
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
    return say(`The draft check is updated (latest input: ${lastText.slice(0, 60)}).`);
  }

  if (opening.includes("Export high-resolution vector figures")) {
    if (!failedT7Once) {
      failedT7Once = true;
      throw new Error("403 forbidden: model quota exceeded");
    }
    return call("report", {
      status: "ready",
      summary: "the retry worked, the high-resolution vector figures are exported",
      artifacts: [{ path: "figs/overview.svg", note: "vector figures" }],
    });
  }

  return say("Got it.");
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

const models = await createModelRuntime(paths, {
  base: (credentials) => {
    const base = createModels({ credentials });
    base.setProvider(faux.provider);
    return base;
  },
});

const store = await SettingsStore.open(paths.settings);
const engine = await Engine.open({
  paths,
  settings: store,
  models,
  context: BACKGROUND_CONTEXT,
  client: { name: "eevee-dev", version },
  // Every connection gets its own in-memory server, so a server reconnected from the panel comes back.
  openMcp: () => fakeMcpServer([weatherTool]).client,
});

const globalRepo = new MemoryRepo(paths.globalMemory);
await globalRepo.ensure("# Global memory\n");
await globalRepo.edit(
  "MEMORY.md",
  "# Global memory\n",
  "# Global memory\n\n- Prefer replies in English, and keep a space between numbers and units\n",
  "seed-global",
);
await globalRepo.commitRound("seed-global", { kind: "router" });

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

const p1 = await engine.createProject({
  title: "Optics paper “Metasurface Polarization Imaging”",
  workspace: ws1,
});
const host1 = engine.project(p1.id);
if (!host1) throw new Error(`No project ${p1.id}`);

const p1Repo = new MemoryRepo(paths.project(p1.id).memory);
await p1Repo.create(
  "optics-sim.md",
  "## FDTD simulation\n- the mesh defaults to λ/15\n- above 45° the PML needs 12 layers\n",
  "seed-p1",
);
await p1Repo.commitRound("seed-p1", { kind: "dreaming", ticketId: "t0" });
await p1Repo.create(
  "writing-style.md",
  "# Writing preferences\n- give the conclusion first, then the evidence\n- use the passive voice sparingly\n",
  "seed-p1-2",
);
await p1Repo.commitRound("seed-p1-2", { kind: "router" });

// Round 1 on p1: t1 created & accepted
await host1.sendUserMessage("First build the paper template, then review and close the ticket.");
await until(async () => {
  const board = await host1.board();
  const conv = await host1.conversation();
  return board.tickets.find((t) => t.ticket.id === "t1")?.ticket.status === "done" && !conv.running;
}, "t1 accepted and closed");

// Round 2 on p1: t2 (jobs), t3 (blocked), t4 (answer), t5 (review), t6 (working), t7 (failed) + q1
await host1.sendUserMessage(
  "Please push the simulation scan, the comparison experiment data, the reference style, the figure redraw, the introduction draft and the vector figure export in parallel.",
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
}, "every p1 ticket reaches its target stage");

// Leave a manual edit in project memory (saved as a user change when first read)
await writeFile(
  join(paths.project(p1.id).memory, "writing-style.md"),
  "# Writing preferences\n- give the conclusion first, then the evidence\n- use the passive voice sparingly\n- legends go in the top right of the figure (local manual edit)\n",
);

// Project 2: Router failure state
const ws2 = join(home, "workspaces", "eevee-demo");
await mkdir(ws2, { recursive: true });
const p2 = await engine.createProject({ title: "Eevee panel integration", workspace: ws2 });
const host2 = engine.project(p2.id);
if (!host2) throw new Error(`No project ${p2.id}`);
await host2.sendUserMessage("Check the stream reconnection and the contract boundaries");
await until(async () => {
  const conv = await host2.conversation();
  return !conv.running && conv.failure !== undefined;
}, "p2 reaches the Router failure state");

// Project 3: Empty project
const ws3 = join(home, "workspaces", "empty");
await mkdir(ws3, { recursive: true });
await engine.createProject({ title: "Blank experiment log", workspace: ws3 });

seeded = true;

if (checkOnly) {
  const board1 = await host1.board();
  const conv2 = await host2.conversation();
  const changes = await host1.memory("project").history();
  console.log("Scenario self-check passed:", {
    projects: engine.projects().map((p) => p.title),
    p1Stages: board1.tickets.map((t) => `${t.ticket.id}:${t.stage}`),
    openQuestions: board1.openQuestions.map((q) => `${q.id}${q.ticketId ? `->${q.ticketId}` : ""}`),
    p2Failure: conv2.failure,
    manualEditChange:
      changes[0]?.source.kind === "user" &&
      changes[0].files.some((f) => f.path === "writing-style.md"),
  });
  await engine.close();
  if (ownHome) await rm(home, { recursive: true, force: true, maxRetries: 5 });
  process.exit(0);
}

const auth = await Auth.open({ tokenPath: paths.runtime.token });

let port = Number(process.env.EEVEE_PORT ?? initialSettings.port);
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await stream.close();
  server.close();
  await engine.close();
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
console.log(`Eevee dev-scenario Engine started (port ${port}, EEVEE_HOME=${home})`);
console.log(
  `  Projects:  ${engine
    .projects()
    .map((p) => `${p.id} “${p.title}”`)
    .join(" / ")}`,
);
console.log(`  Built-in UI: http://127.0.0.1:${port}/ui/#code=${encodeURIComponent(codeUi)}`);
console.log(`  Vite dev:    http://127.0.0.1:5173/ui/#code=${encodeURIComponent(codeVite)}`);
console.log("  Press Ctrl+C to stop and clean up the temporary directory.");

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
