import { connectLocalEngine } from "@eevee/engine";
import type { Command } from "commander";
import { printResult, runEngineCommand } from "../command-helpers.ts";
import { formatProviders } from "../format.ts";
import { runProviderLogin } from "../login-ui.ts";

export function registerAuthCommands(program: Command, env: NodeJS.ProcessEnv): void {
  const authCommand = program.command("auth").description("Manage provider credentials");

  authCommand
    .command("status")
    .description("List provider authentication status")
    .option("--json", "Output JSON")
    .action((options: { json?: boolean }) =>
      runEngineCommand(env, options, (client) => client.listProviders(), formatProviders),
    );

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
        if (options.apiKey !== undefined) {
          const apiKey = options.apiKey;
          await runEngineCommand(
            env,
            options,
            (client) => client.setProviderApiKey(providerId, { key: apiKey }),
            () => `Saved API key for ${providerId}`,
          );
          return;
        }
        const { client } = await connectLocalEngine(env);
        const complete = await runProviderLogin({
          client,
          providerId,
          oauth: options.oauth,
          json: options.json,
        });
        if (complete !== undefined) {
          printResult(
            complete,
            options,
            (item) => `Authenticated ${item.providerId} (${item.type})`,
          );
        }
      },
    );

  authCommand
    .command("logout")
    .description("Remove stored credentials for a provider")
    .argument("<provider>", "Provider ID")
    .option("--json", "Output JSON")
    .action((providerId: string, options: { json?: boolean }) =>
      runEngineCommand(
        env,
        options,
        (client) => client.logoutProvider(providerId),
        () => `Logged out of ${providerId}`,
      ),
    );
}
