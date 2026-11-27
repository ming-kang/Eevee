import { resolve } from "node:path";
import type { ModelSlotsOverride, ToolsSettings, UpdateProjectRequest } from "@eevee/protocol";
import type { Command } from "commander";
import {
  addModelSlotOptions,
  addToolSettingsOptions,
  hasModelSlots,
  parseModelSlotFlags,
  parseToolsSettingsFlags,
  readTextInput,
} from "../args.ts";
import { runEngineCommand } from "../command-helpers.ts";
import { formatProjectUsage, tabular } from "../format.ts";

export function mergeProjectModels(
  existing: ModelSlotsOverride | undefined,
  incoming: ModelSlotsOverride,
): ModelSlotsOverride {
  return {
    ...(existing ?? {}),
    ...incoming,
  };
}

export function mergeToolsSettings(
  existing: ToolsSettings | undefined,
  incoming: ToolsSettings,
): ToolsSettings {
  const router =
    existing?.router !== undefined || incoming.router !== undefined
      ? { ...(existing?.router ?? {}), ...(incoming.router ?? {}) }
      : undefined;
  const worker =
    existing?.worker !== undefined || incoming.worker !== undefined
      ? { ...(existing?.worker ?? {}), ...(incoming.worker ?? {}) }
      : undefined;
  const codemode =
    existing?.codemode !== undefined || incoming.codemode !== undefined
      ? { ...(existing?.codemode ?? {}), ...(incoming.codemode ?? {}) }
      : undefined;

  return {
    ...(router === undefined ? {} : { router }),
    ...(worker === undefined ? {} : { worker }),
    ...(codemode === undefined ? {} : { codemode }),
  };
}

export function registerProjectCommands(program: Command, env: NodeJS.ProcessEnv): void {
  const projectCommand = program.command("project").description("Manage Eevee projects");

  const projectCreateCommand = projectCommand
    .command("create")
    .description("Create a new project")
    .argument("[workspaces...]", "Workspace directories (defaults to current working directory)")
    .option("--title <title>", "Human-readable project title")
    .option("--memory <text>", "Initial project memory instructions");
  addModelSlotOptions(projectCreateCommand)
    .option("--json", "Output JSON")
    .action(
      async (
        workspaces: string[],
        options: {
          title?: string;
          memory?: string;
          routerModel?: string;
          workerModel?: string;
          dreamerModel?: string;
          json?: boolean;
        },
      ) => {
        const resolvedWorkspaces = (workspaces.length > 0 ? workspaces : [process.cwd()]).map(
          (dir) => resolve(dir),
        );
        const models = parseModelSlotFlags(options);

        await runEngineCommand(
          env,
          options,
          (client) =>
            client.createProject({
              workspaces: resolvedWorkspaces,
              ...(options.title === undefined ? {} : { title: options.title }),
              ...(options.memory === undefined ? {} : { memory: options.memory }),
              ...(hasModelSlots(models) ? { models } : {}),
            }),
          ({ project }) =>
            `Created project ${project.id} (${project.title})\nWorkspaces: ${project.workspaces.join(", ")}`,
        );
      },
    );

  projectCommand
    .command("list")
    .description("List projects hosted by the local Engine")
    .option("--json", "Output JSON")
    .action((options: { json?: boolean }) =>
      runEngineCommand(
        env,
        options,
        (client) => client.listProjects(),
        (response) =>
          response.projects.length === 0
            ? "No projects."
            : tabular(response.projects.map((p) => [p.id, p.title, p.workspaces.join(", ")])),
      ),
    );

  const projectUpdateCommand = projectCommand
    .command("update")
    .description("Update project metadata, workspaces, memory, or model overrides")
    .argument("<project>", "Project ID")
    .option("--title <title>", "New project title")
    .option("--workspace <dirs...>", "Replace project workspace directories")
    .option("--memory <text>", "Set project memory instructions")
    .option("--clear-memory", "Clear project memory instructions");
  addModelSlotOptions(projectUpdateCommand).option(
    "--clear-models",
    "Clear project model overrides",
  );
  addToolSettingsOptions(projectUpdateCommand)
    .option("--clear-tools", "Clear project tool overrides to inherit global settings")
    .option("--json", "Output JSON")
    .action(
      async (
        projectId: string,
        options: {
          title?: string;
          workspace?: string[];
          memory?: string;
          clearMemory?: boolean;
          routerModel?: string;
          workerModel?: string;
          dreamerModel?: string;
          clearModels?: boolean;
          routerTools?: string | readonly string[];
          workerTools?: string | readonly string[];
          codemodeMode?: string;
          codemodeInlineBudget?: string;
          clearTools?: boolean;
          json?: boolean;
        },
      ) => {
        if (options.memory !== undefined && options.clearMemory) {
          throw new Error("Cannot combine --memory and --clear-memory");
        }
        const hasModelFlag =
          options.routerModel !== undefined ||
          options.workerModel !== undefined ||
          options.dreamerModel !== undefined;
        if (hasModelFlag && options.clearModels) {
          throw new Error("Cannot combine model override flags with --clear-models");
        }
        const hasToolsFlag =
          options.routerTools !== undefined ||
          options.workerTools !== undefined ||
          options.codemodeMode !== undefined ||
          options.codemodeInlineBudget !== undefined;
        if (hasToolsFlag && options.clearTools) {
          throw new Error("Cannot combine tool override flags with --clear-tools");
        }
        const tools = parseToolsSettingsFlags(options);
        const incomingModels = hasModelFlag ? parseModelSlotFlags(options) : undefined;
        const patch: UpdateProjectRequest = {};
        if (options.title !== undefined) patch.title = options.title;
        if (options.workspace !== undefined) {
          patch.workspaces = options.workspace.map((dir) => resolve(dir));
        }
        if (options.clearMemory) patch.memory = null;
        else if (options.memory !== undefined) patch.memory = options.memory;
        if (options.clearModels) patch.models = null;
        else if (incomingModels !== undefined) patch.models = incomingModels;
        if (options.clearTools) patch.tools = null;
        else if (tools !== undefined) patch.tools = tools;

        if (Object.keys(patch).length === 0) {
          throw new Error("Specify at least one field to update.");
        }

        await runEngineCommand(
          env,
          options,
          async (client) => {
            if (incomingModels !== undefined || (tools !== undefined && !options.clearTools)) {
              const { project: existing } = await client.getProject(projectId);
              if (incomingModels !== undefined) {
                patch.models = mergeProjectModels(existing.models, incomingModels);
              }
              if (tools !== undefined && !options.clearTools) {
                patch.tools = mergeToolsSettings(existing.tools, tools);
              }
            }
            return client.updateProject(projectId, patch);
          },
          ({ project }) => `Updated project ${project.id} (${project.title})`,
        );
      },
    );

  projectCommand
    .command("remove")
    .description("Remove a project and its session data (never deletes workspace files)")
    .argument("<project>", "Project ID")
    .option("--json", "Output JSON")
    .action((projectId: string, options: { json?: boolean }) =>
      runEngineCommand(
        env,
        options,
        (client) => client.deleteProject(projectId),
        (response) => `Removed project ${response.id}`,
      ),
    );

  const projectMemoryCommand = projectCommand
    .command("memory")
    .description("Read or update project memory instructions");

  projectMemoryCommand
    .command("get")
    .description("Get project memory instructions")
    .argument("<project>", "Project ID")
    .option("--json", "Output JSON")
    .action((projectId: string, options: { json?: boolean }) =>
      runEngineCommand(
        env,
        options,
        (client) => client.getProjectMemory(projectId),
        (response) => response.memory ?? "(no project memory)",
      ),
    );

  projectMemoryCommand
    .command("set")
    .description("Set or clear project memory instructions")
    .argument("<project>", "Project ID")
    .argument("[text]", "Project memory text")
    .option("--file <path>", "Read project memory from a file")
    .option("--clear", "Clear project memory")
    .option("--json", "Output JSON")
    .action(
      async (
        projectId: string,
        text: string | undefined,
        options: { file?: string; clear?: boolean; json?: boolean },
      ) => {
        const sources = [
          text !== undefined ? 1 : 0,
          options.file !== undefined ? 1 : 0,
          options.clear ? 1 : 0,
        ].reduce((a, b) => a + b, 0);
        if (sources > 1) {
          throw new Error("Specify only one of [text], --file, or --clear");
        }
        const memory = options.clear
          ? null
          : text !== undefined
            ? text
            : await readTextInput(options.file);
        await runEngineCommand(
          env,
          options,
          (client) => client.putProjectMemory(projectId, { memory }),
          (response) =>
            response.memory === null
              ? `Cleared project memory for ${response.projectId}`
              : `Updated project memory for ${response.projectId}`,
        );
      },
    );

  projectCommand
    .command("usage")
    .description("Show accumulated model and tool usage for a project")
    .argument("<project>", "Project ID")
    .option("--json", "Output JSON")
    .action((projectId: string, options: { json?: boolean }) =>
      runEngineCommand(
        env,
        options,
        (client) => client.getProjectUsage(projectId),
        formatProjectUsage,
      ),
    );
}
