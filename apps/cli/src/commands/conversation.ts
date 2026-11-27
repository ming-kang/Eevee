import { connectLocalEngine } from "@eevee/engine";
import {
  type ConversationRef,
  parseWithSchema,
  QuestionIdSchema,
  type WhenBusy,
  WhenBusySchema,
  WorkerIdSchema,
} from "@eevee/protocol";
import type { Command } from "commander";
import { parseConversationRefArg, parsePositiveIntFlag } from "../args.ts";
import { runEngineCommand, withSignalAbort } from "../command-helpers.ts";
import { ConversationWatchRenderer, formatBoard, formatQuestionAnswered } from "../format.ts";

export function registerConversationCommands(program: Command, env: NodeJS.ProcessEnv): void {
  program
    .command("send")
    .description("Send a message to a project's Router or Worker")
    .argument("<project>", "Project ID")
    .argument("<text>", "Message text")
    .option("--worker <wN>", "Target Worker ID (defaults to router)")
    .option("--when-busy <mode>", "Busy behavior: steer, followUp, or reject")
    .option("--json", "Output JSON")
    .action(
      async (
        projectId: string,
        text: string,
        options: { worker?: string; whenBusy?: string; json?: boolean },
      ) => {
        const ref: ConversationRef =
          options.worker === undefined
            ? "router"
            : parseWithSchema(WorkerIdSchema, options.worker, "--worker");
        let whenBusy: WhenBusy | undefined;
        if (options.whenBusy !== undefined) {
          whenBusy = parseWithSchema(WhenBusySchema, options.whenBusy, "--when-busy");
        }
        await runEngineCommand(
          env,
          options,
          (client) =>
            client.sendMessage(projectId, ref, {
              text,
              ...(whenBusy === undefined ? {} : { whenBusy }),
            }),
          (response) => `Sent submission ${response.submissionId} (${response.status})`,
        );
      },
    );

  program
    .command("board")
    .description("Inspect a project's Workers, Tickets, and Questions")
    .argument("<project>", "Project ID")
    .option("--watch", "Stream live Board updates")
    .option("--json", "Output JSON")
    .action(async (projectId: string, options: { watch?: boolean; json?: boolean }) => {
      if (!options.watch) {
        await runEngineCommand(env, options, (client) => client.getBoard(projectId), formatBoard);
        return;
      }
      const { client } = await connectLocalEngine(env);
      await withSignalAbort(async (signal) => {
        for await (const event of client.streamBoard(projectId, { signal })) {
          if (event.type === "board") {
            if (options.json) {
              console.log(JSON.stringify(event.board));
            } else {
              console.log(formatBoard(event.board));
              console.log("---");
            }
          } else if (event.type === "end") {
            break;
          }
        }
      });
    });

  program
    .command("watch")
    .description("Stream a project's Router or Worker conversation")
    .argument("<project>", "Project ID")
    .argument("[ref]", "Conversation target (router or wN)", "router")
    .option("--from <entryId>", "Resume from entry ID (inclusive)")
    .option("--last-event-id <entryId>", "Resume strictly after event ID (Last-Event-ID)")
    .option("--json", "Output NDJSON stream events")
    .action(
      async (
        projectId: string,
        rawRef: string,
        options: { from?: string; lastEventId?: string; json?: boolean },
      ) => {
        const ref = parseConversationRefArg(rawRef);
        const from =
          options.from === undefined ? undefined : parsePositiveIntFlag(options.from, "--from");
        const lastEventId =
          options.lastEventId === undefined
            ? undefined
            : parsePositiveIntFlag(options.lastEventId, "--last-event-id");
        const { client } = await connectLocalEngine(env);
        const renderer = new ConversationWatchRenderer((chunk) => {
          process.stdout.write(chunk);
        });

        await withSignalAbort(async (signal) => {
          for await (const event of client.streamConversation(projectId, ref, {
            ...(from === undefined ? {} : { from }),
            ...(lastEventId === undefined ? {} : { lastEventId }),
            signal,
          })) {
            if (options.json) {
              process.stdout.write(`${JSON.stringify(event)}\n`);
              if (event.type === "end") break;
              continue;
            }
            if (event.type === "snapshot") {
              renderer.onSnapshot(event.view);
            } else if (event.type === "patch") {
              renderer.onPatch(event.view);
            } else if (event.type === "failed") {
              renderer.onFailed(event.message);
            } else if (event.type === "end") {
              renderer.onEnd();
              break;
            }
          }
        });
      },
    );

  program
    .command("answer")
    .description("Answer a pending Router question")
    .argument("<project>", "Project ID")
    .argument("<questionId>", "Question ID (e.g. q1)")
    .argument("<answers...>", "Answer(s) in question order")
    .option("--json", "Output JSON")
    .action(
      async (
        projectId: string,
        rawQuestionId: string,
        answers: string[],
        options: { json?: boolean },
      ) => {
        const questionId = parseWithSchema(QuestionIdSchema, rawQuestionId, "questionId");
        await runEngineCommand(
          env,
          options,
          (client) => client.answerQuestion(projectId, questionId, { answers }),
          formatQuestionAnswered,
        );
      },
    );

  program
    .command("interrupt")
    .description("Interrupt a running Router or Worker conversation")
    .argument("<project>", "Project ID")
    .argument("[ref]", "Conversation target (router or wN)", "router")
    .option("--json", "Output JSON")
    .action(async (projectId: string, rawRef: string, options: { json?: boolean }) => {
      const ref = parseConversationRefArg(rawRef);
      await runEngineCommand(
        env,
        options,
        (client) => client.interrupt(projectId, ref),
        () => `Interrupted ${ref}`,
      );
    });

  program
    .command("retry")
    .description("Retry or continue an idle Router or Worker conversation")
    .argument("<project>", "Project ID")
    .argument("[ref]", "Conversation target (router or wN)", "router")
    .option("--json", "Output JSON")
    .action(async (projectId: string, rawRef: string, options: { json?: boolean }) => {
      const ref = parseConversationRefArg(rawRef);
      await runEngineCommand(
        env,
        options,
        (client) => client.retry(projectId, ref),
        (response) => `Retried ${ref} (submission ${response.submissionId}, ${response.status})`,
      );
    });
}
