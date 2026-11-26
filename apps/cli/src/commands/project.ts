import { resolve } from "node:path";
import { connectLocalEngine } from "@eevee/engine";
import type { UpdateProjectRequest } from "@eevee/protocol";
import type { Command } from "commander";
import {
  collectRepeatedFlag,
  hasModelSlots,
  parseModelSlotFlags,
  parseToolsSettingsFlags,
  readTextInput,
} from "../args.ts";
import { formatProjectUsage } from "../format.ts";

export function registerProjectCommands(program: Command, env: NodeJS.ProcessEnv): void {
  const projectCommand = program.command("project").description("Manage Eevee projects");

  projectCommand
    .command("create")
    .description("Create a new project")
    .argument("[workspaces...]", "Workspace directories (defaults to current working directory)")
    .option("--title <title>", "Human-readable project title")
    .option("--memory <text>", "Initial project memory instructions")
    .option("--router-model <provider/modelId>", "Router model override")
    .option("--worker-model <provider/modelId>", "Worker model override")
    .option("--dreamer-model <provider/modelId>", "Dreamer model override")
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

        const { client } = await connectLocalEngine(env);
        const response = await client.createProject({
          workspaces: resolvedWorkspaces,
          ...(options.title === undefined ? {} : { title: options.title }),
          ...(options.memory === undefined ? {} : { memory: options.memory }),
          ...(hasModelSlots(models) ? { models } : {}),
        });

        if (options.json) {
          console.log(JSON.stringify(response, null, 2));
          return;
        }
        const { project } = response;
        console.log(`Created project ${project.id} (${project.title})`);
        console.log(`Workspaces: ${project.workspaces.join(", ")}`);
      },
    );

  projectCommand
    .command("list")
    .description("List projects hosted by the local Engine")
    .option("--json", "Output JSON")
    .action(async (options: { json?: boolean }) => {
      const { client } = await connectLocalEngine(env);
      const response = await client.listProjects();
      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }
      if (response.projects.length === 0) {
        console.log("No projects.");
        return;
      }
      for (const project of response.projects) {
        console.log(`${project.id}\t${project.title}\t${project.workspaces.join(", ")}`);
      }
    });

  projectCommand
    .command("update")
    .description("Update project metadata, workspaces, memory, or model overrides")
    .argument("<project>", "Project ID")
    .option("--title <title>", "New project title")
    .option("--workspace <dirs...>", "Replace project workspace directories")
    .option("--memory <text>", "Set project memory instructions")
    .option("--clear-memory", "Clear project memory instructions")
    .option("--router-model <provider/modelId>", "Router model override")
    .option("--worker-model <provider/modelId>", "Worker model override")
    .option("--dreamer-model <provider/modelId>", "Dreamer model override")
    .option("--clear-models", "Clear project model overrides")
    .option("--router-tools <specs>", "Toggle Router tools, e.g. -ls,+grep", collectRepeatedFlag)
    .option(
      "--worker-tools <specs>",
      "Toggle Worker tools, e.g. -bash,+powershell,+grep",
      collectRepeatedFlag,
    )
    .option("--codemode-mode <mode>", "Codemode mode: off, on, or only")
    .option(
      "--codemode-inline-budget <n>",
      "Estimated token budget for inline codemode declarations",
    )
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

        const patch: UpdateProjectRequest = {};
        if (options.title !== undefined) patch.title = options.title;
        if (options.workspace !== undefined) {
          patch.workspaces = options.workspace.map((dir) => resolve(dir));
        }
        if (options.clearMemory) patch.memory = null;
        else if (options.memory !== undefined) patch.memory = options.memory;

        if (options.clearModels) {
          patch.models = null;
        } else if (hasModelFlag) {
          patch.models = parseModelSlotFlags(options);
        }
        if (options.clearTools) {
          patch.tools = null;
        } else if (tools !== undefined) {
          patch.tools = tools;
        }

        if (Object.keys(patch).length === 0) {
          throw new Error("Specify at least one field to update.");
        }

        const { client } = await connectLocalEngine(env);
        const response = await client.updateProject(projectId, patch);
        if (options.json) {
          console.log(JSON.stringify(response, null, 2));
          return;
        }
        console.log(`Updated project ${response.project.id} (${response.project.title})`);
      },
    );

  projectCommand
    .command("remove")
    .description("Remove a project and its session data (never deletes workspace files)")
    .argument("<project>", "Project ID")
    .option("--json", "Output JSON")
    .action(async (projectId: string, options: { json?: boolean }) => {
      const { client } = await connectLocalEngine(env);
      const response = await client.deleteProject(projectId);
      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }
      console.log(`Removed project ${response.id}`);
    });

  const projectMemoryCommand = projectCommand
    .command("memory")
    .description("Read or update project memory instructions");

  projectMemoryCommand
    .command("get")
    .description("Get project memory instructions")
    .argument("<project>", "Project ID")
    .option("--json", "Output JSON")
    .action(async (projectId: string, options: { json?: boolean }) => {
      const { client } = await connectLocalEngine(env);
      const response = await client.getProjectMemory(projectId);
      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }
      console.log(response.memory ?? "(no project memory)");
    });

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
        const { client } = await connectLocalEngine(env);
        const response = await client.putProjectMemory(projectId, { memory });
        if (options.json) {
          console.log(JSON.stringify(response, null, 2));
          return;
        }
        console.log(
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
    .action(async (projectId: string, options: { json?: boolean }) => {
      const { client } = await connectLocalEngine(env);
      const response = await client.getProjectUsage(projectId);
      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }
      console.log(formatProjectUsage(response));
    });
}
