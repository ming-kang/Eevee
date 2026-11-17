import type { Command } from "commander";
import type { CapabilitiesView } from "../../api/contract.ts";
import { ROLE_NAMES, type RoleName } from "../../contracts/index.ts";
import type { EeveePaths } from "../../shared/paths.ts";
import { connect } from "../connection.ts";

export function capabilityCommands(program: Command, paths: EeveePaths): void {
  const role = program.command("role").description("各角色启用的扩展");

  role
    .command("list")
    .description("查看各角色的扩展、可启用的扩展与 MCP 服务器")
    .action(async () => {
      const { client } = await connect(paths);
      printCapabilities(await client.call("GET /api/capabilities"));
    });

  role
    .command("enable <role> <extensions...>")
    .description("为角色启用扩展（如 mcp.deepwiki）")
    .action(async (name: string, extensions: string[]) => {
      await changeExtensions(paths, roleName(name), (current) => [...current, ...extensions]);
    });

  role
    .command("disable <role> <extensions...>")
    .description("为角色停用扩展")
    .action(async (name: string, extensions: string[]) => {
      await changeExtensions(paths, roleName(name), (current) =>
        current.filter((e) => !extensions.includes(e)),
      );
    });

  role
    .command("turns <role> <limit>")
    .description("设置角色每次运行的最多轮次；default 恢复默认")
    .action(async (name: string, limit: string) => {
      const maxTurns = limit === "default" ? null : Number(limit);
      if (maxTurns !== null && !(Number.isInteger(maxTurns) && maxTurns >= 1)) {
        throw new Error("轮次应为正整数，或 default");
      }
      const { client } = await connect(paths);
      await client.call(
        "POST /api/capabilities/roles/:role",
        { role: roleName(name) },
        { maxTurns },
      );
      console.log(
        maxTurns === null ? `${name} 恢复默认轮次上限` : `${name} 每次运行最多 ${maxTurns} 轮`,
      );
    });

  const mcp = program.command("mcp").description("MCP 服务器（~/.eevee/mcp.json）");

  mcp
    .command("list")
    .description("查看 MCP 服务器的连接状态")
    .action(async () => {
      const { client } = await connect(paths);
      printMcp(await client.call("GET /api/capabilities"));
    });

  mcp
    .command("reload")
    .description("重新读取 mcp.json 并重连全部服务器")
    .action(async () => {
      const { client } = await connect(paths);
      printMcp(await client.call("POST /api/mcp/reload"));
    });
}

function roleName(value: string): RoleName {
  if (!ROLE_NAMES.includes(value as RoleName)) {
    throw new Error(`角色只能是 ${ROLE_NAMES.join("、")}`);
  }
  return value as RoleName;
}

async function changeExtensions(
  paths: EeveePaths,
  role: RoleName,
  change: (current: readonly string[]) => string[],
): Promise<void> {
  const { client } = await connect(paths);
  const current = (await client.call("GET /api/capabilities")).roles.find((r) => r.role === role);
  const view = await client.call(
    "POST /api/capabilities/roles/:role",
    { role },
    { extensions: change(current?.enabled ?? []) },
  );
  const updated = view.roles.find((r) => r.role === role);
  console.log(`${role} 启用的扩展：${updated?.enabled.join("、") || "（无）"}`);
}

function printCapabilities(view: CapabilitiesView): void {
  for (const r of view.roles) {
    const added = r.enabled.length > 0 ? ` + ${r.enabled.join("、")}` : "";
    const turns = r.maxTurns === undefined ? "" : `，每次最多 ${r.maxTurns} 轮`;
    console.log(`${r.role}：${r.builtIn.join("、")}${added}${turns}`);
  }
  console.log("\n可启用：");
  for (const e of view.available) console.log(`  ${e.name}（${e.tools} 个工具）`);
  for (const u of view.userExtensions) {
    if (u.error !== undefined) console.log(`  ✗ ${u.file}：${u.error}`);
  }
  printMcp(view);
}

function printMcp(view: CapabilitiesView): void {
  if (view.mcp.length === 0 && view.problems.length === 0) {
    console.log("\n没有配置 MCP 服务器（~/.eevee/mcp.json）。");
    return;
  }
  console.log("\nMCP：");
  for (const s of view.mcp) {
    const tools = s.state === "connected" ? `，${s.tools} 个工具` : "";
    const error = s.error === undefined ? "" : `：${s.error}`;
    console.log(`  ${s.extension} [${s.state}] ${s.exposure}${tools}${error}`);
  }
  for (const problem of view.problems) console.log(`  ✗ ${problem}`);
}
