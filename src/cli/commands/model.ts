import type { Command } from "commander";
import type { EeveePaths } from "../../shared/paths.ts";
import { connect } from "../connection.ts";

export function modelCommands(program: Command, paths: EeveePaths): void {
  const model = program.command("model").description("模型与凭据");

  model
    .command("list")
    .description("查看默认模型、已登录 provider 的模型与使用经验")
    .action(async () => {
      const { client } = await connect(paths);
      console.log((await client.call("GET /api/models")).catalog);
    });

  model
    .command("default <model>")
    .description("设置默认模型，格式 provider/modelId")
    .option("-r, --role <role>", "只为某个角色设置：router、worker 或 dreamer", "default")
    .action(async (ref: string, options: { role: string }) => {
      const slash = ref.indexOf("/");
      if (slash <= 0 || slash === ref.length - 1) throw new Error("模型格式应为 provider/modelId");
      const { client } = await connect(paths);
      await client.call("POST /api/settings/models", {
        role: options.role as "default",
        provider: ref.slice(0, slash),
        modelId: ref.slice(slash + 1),
      });
      console.log(`已设置 ${options.role} 模型为 ${ref}`);
    });

  model
    .command("login <provider>")
    .description("保存 provider 的 API key（从标准输入读取）")
    .action(async (provider: string) => {
      const key = (await readStdin()).trim();
      if (!key) throw new Error("没有读到 API key：echo $KEY | eevee model login <provider>");
      const { client } = await connect(paths);
      await client.call("POST /api/auth/:provider", { provider }, { key });
      console.log(`已保存 ${provider} 的凭据`);
    });
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) process.stdout.write("API key: ");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
    if (process.stdin.isTTY && chunk.includes(10)) break;
  }
  return Buffer.concat(chunks).toString("utf8");
}
