import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_ROOTS = ["packages", "apps", "scripts"];
const IGNORED = new Set(["node_modules", "dist", ".git"]);

const CREDENTIAL_VARIABLES = [
  "AI_GATEWAY_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANT_LING_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_DEFAULT_PROFILE",
  "AWS_PROFILE",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AZURE_OPENAI_API_KEY",
  "BASETEN_API_KEY",
  "CEREBRAS_API_KEY",
  "COPILOT_GITHUB_TOKEN",
  "DEEPSEEK_API_KEY",
  "FIREWORKS_API_KEY",
  "GEMINI_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GROQ_API_KEY",
  "HF_TOKEN",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
  "MISTRAL_API_KEY",
  "NVIDIA_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "QWEN_TOKEN_PLAN_API_KEY",
  "TOGETHER_API_KEY",
  "XAI_API_KEY",
  "XIAOMI_API_KEY",
  "ZAI_API_KEY",
];

const PROXY_VARIABLES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
];

export function createTestEnvironment(base: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.EEVEE_HOME;
  for (const name of CREDENTIAL_VARIABLES) delete env[name];
  for (const name of PROXY_VARIABLES) delete env[name];

  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = join(home, ".config");
  env.XDG_CACHE_HOME = join(home, ".cache");
  env.XDG_DATA_HOME = join(home, ".local", "share");
  env.XDG_STATE_HOME = join(home, ".local", "state");

  const temp = join(home, "tmp");
  env.TMPDIR = temp;
  env.TMP = temp;
  env.TEMP = temp;
  return env;
}

function collectTests(target: string): string[] {
  const full = resolve(root, target);
  if (!existsSync(full)) return [];
  const stat = statSync(full);
  if (stat.isFile()) return full.endsWith(".test.ts") ? [full] : [];
  const found: string[] = [];
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const child = join(full, entry.name);
    if (entry.isDirectory()) found.push(...collectTests(child));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) found.push(child);
  }
  return found;
}

function main(): void {
  const rawArgs = process.argv.slice(2);
  const targets: string[] = [];
  const passthrough: string[] = [];
  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index];
    if (arg === undefined) continue;
    if (arg === "--") {
      passthrough.push(...rawArgs.slice(index + 1));
      break;
    }
    if (arg.startsWith("-")) {
      passthrough.push(arg);
    } else {
      targets.push(arg);
    }
  }

  const files = (targets.length > 0 ? targets : DEFAULT_ROOTS).flatMap(collectTests).sort();
  if (files.length === 0) {
    console.error("No test files found.");
    process.exit(1);
  }

  const home = mkdtempSync(join(tmpdir(), "eevee-test-home-"));
  mkdirSync(join(home, "tmp"));
  try {
    const result = spawnSync(
      process.execPath,
      ["--conditions=eevee-source", "--test", ...passthrough, ...files],
      {
        cwd: root,
        stdio: "inherit",
        env: createTestEnvironment(process.env, home),
      },
    );
    process.exit(result.status ?? 1);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
