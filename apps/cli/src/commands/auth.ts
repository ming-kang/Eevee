import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { connectLocalEngine } from "@eevee/engine";
import type { AuthType } from "@eevee/protocol";
import type { Command } from "commander";
import { formatProviders } from "../format.ts";

export function registerAuthCommands(program: Command, env: NodeJS.ProcessEnv): void {
  const authCommand = program.command("auth").description("Manage provider credentials");

  authCommand
    .command("status")
    .description("List provider authentication status")
    .option("--json", "Output JSON")
    .action(async (options: { json?: boolean }) => {
      const { client } = await connectLocalEngine(env);
      const response = await client.listProviders();
      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }
      console.log(formatProviders(response));
    });

  authCommand
    .command("login")
    .description("Authenticate a provider via API key or interactive OAuth")
    .argument("<provider>", "Provider ID")
    .option("--api-key <key>", "Store an API key non-interactively")
    .option("--oauth", "Use interactive OAuth login")
    .option("--json", "Output JSON")
    .action(
      async (providerId: string, options: { apiKey?: string; oauth?: boolean; json?: boolean }) => {
        if (options.apiKey !== undefined && options.oauth) {
          throw new Error("Cannot combine --api-key and --oauth");
        }
        const { client } = await connectLocalEngine(env);
        if (options.apiKey !== undefined) {
          const response = await client.setProviderApiKey(providerId, { key: options.apiKey });
          if (options.json) {
            console.log(JSON.stringify(response, null, 2));
            return;
          }
          console.log(`Saved API key for ${providerId}`);
          return;
        }

        const { providers } = await client.listProviders();
        const provider = providers.find((entry) => entry.id === providerId);
        if (provider === undefined) {
          throw new Error(`Unknown provider "${providerId}"`);
        }

        const promptOut = options.json ? process.stderr : process.stdout;
        let echoMuted = false;
        const echoOut = new Writable({
          write(chunk, encoding, callback) {
            if (echoMuted) callback();
            else promptOut.write(chunk, encoding, () => callback());
          },
        });
        const rl = createInterface({
          input: process.stdin,
          output: echoOut,
          terminal: process.stdin.isTTY === true,
        });
        const questionHidden = async (query: string): Promise<string> => {
          promptOut.write(query);
          echoMuted = true;
          try {
            return await rl.question("");
          } finally {
            echoMuted = false;
            promptOut.write("\n");
          }
        };
        let loginType: AuthType;
        try {
          if (options.oauth) {
            if (!provider.authMethods.oauth) {
              throw new Error(`Provider "${providerId}" does not support OAuth login`);
            }
            loginType = "oauth";
          } else if (provider.authMethods.oauth && !provider.authMethods.apiKeyLogin) {
            loginType = "oauth";
          } else if (!provider.authMethods.oauth && provider.authMethods.apiKeyLogin) {
            loginType = "api_key";
          } else if (provider.authMethods.oauth && provider.authMethods.apiKeyLogin) {
            const oauthLabel =
              provider.authMethods.oauthLabel ?? provider.authMethods.oauthName ?? "OAuth";
            promptOut.write(`Choose login method for ${provider.name}:\n`);
            promptOut.write(`  1) ${oauthLabel}\n`);
            promptOut.write("  2) API key\n");
            const choice = (await rl.question("Select [1/2]: ")).trim();
            if (choice === "1" || choice.toLowerCase() === "oauth") {
              loginType = "oauth";
            } else if (choice === "2" || choice.toLowerCase() === "api_key") {
              loginType = "api_key";
            } else {
              throw new Error(`Invalid login method selection "${choice}"`);
            }
          } else {
            throw new Error(
              `Provider "${providerId}" does not support interactive login; pass --api-key <key>.`,
            );
          }

          const session = await client.startProviderLogin(providerId, { type: loginType });
          const controller = new AbortController();
          const onSignal = () => {
            controller.abort();
            void client.cancelLoginSession(providerId, session.sessionId).catch(() => undefined);
          };
          process.on("SIGINT", onSignal);
          process.on("SIGTERM", onSignal);
          try {
            for await (const item of client.streamLoginSession(providerId, session.sessionId, {
              signal: controller.signal,
            })) {
              if (item.type === "auth") {
                const evt = item.event;
                if (evt.type === "auth_url") {
                  promptOut.write(`Open URL: ${evt.url}\n`);
                  if (evt.instructions) promptOut.write(`${evt.instructions}\n`);
                } else if (evt.type === "device_code") {
                  promptOut.write(`Enter code ${evt.userCode} at ${evt.verificationUri}\n`);
                } else {
                  promptOut.write(`${evt.message}\n`);
                }
              } else if (item.type === "prompt") {
                const prompt = item.prompt;
                let value: string;
                if (prompt.type === "select") {
                  promptOut.write(`${prompt.message}\n`);
                  prompt.options.forEach((opt, idx) => {
                    const desc = opt.description ? ` — ${opt.description}` : "";
                    promptOut.write(`  ${idx + 1}) ${opt.label} (${opt.id})${desc}\n`);
                  });
                  const answer = (await rl.question("Select option: ")).trim();
                  const asIndex = Number(answer);
                  if (
                    Number.isInteger(asIndex) &&
                    asIndex >= 1 &&
                    asIndex <= prompt.options.length
                  ) {
                    value = prompt.options[asIndex - 1]?.id ?? answer;
                  } else {
                    value = answer;
                  }
                } else {
                  const suffix = prompt.placeholder ? ` (${prompt.placeholder})` : "";
                  const query = `${prompt.message}${suffix}: `;
                  value =
                    prompt.type === "secret"
                      ? await questionHidden(query)
                      : await rl.question(query);
                }
                await client.submitLoginInput(providerId, session.sessionId, {
                  promptId: prompt.promptId,
                  value,
                });
              } else if (item.type === "complete") {
                if (options.json) {
                  console.log(JSON.stringify(item.complete, null, 2));
                } else {
                  console.log(`Authenticated ${item.complete.providerId} (${item.complete.type})`);
                }
                return;
              } else if (item.type === "error") {
                throw new Error(item.error.message);
              }
            }
          } finally {
            process.off("SIGINT", onSignal);
            process.off("SIGTERM", onSignal);
          }
        } finally {
          rl.close();
        }
      },
    );

  authCommand
    .command("logout")
    .description("Remove stored credentials for a provider")
    .argument("<provider>", "Provider ID")
    .option("--json", "Output JSON")
    .action(async (providerId: string, options: { json?: boolean }) => {
      const { client } = await connectLocalEngine(env);
      const response = await client.logoutProvider(providerId);
      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }
      console.log(`Logged out of ${providerId}`);
    });
}
