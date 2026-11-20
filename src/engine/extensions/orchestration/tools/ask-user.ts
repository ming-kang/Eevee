import { defineTool } from "@earendil-works/pi-durable";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import { executeAskUser } from "../../../orchestration/ask-user.ts";
import { toolResult } from "../result.ts";

export const ASK_USER_TOOL = "ask_user";

const Parameters = obj({
  items: arr(
    obj({
      text: str({ description: "The question itself" }),
      options: arr(str(), {
        description: "The possible answers; leave empty for an open question",
      }),
      recommended: opt(str({ description: "The recommended answer" })),
    }),
    { minItems: 1, description: "A numbered round of questions, each with a recommended answer" },
  ),
  ticketId: opt(
    str({
      pattern: "^t[1-9][0-9]*$",
      description: "The ticket the question comes from; the answer is delivered straight to it",
    }),
  ),
});

export const askUserTool = defineTool({
  name: ASK_USER_TOOL,
  description:
    "Ask the user a round of structured questions. Return right away without waiting; the answer arrives " +
    "as a new message once the user replies. Use it only when the user has to decide, and look up what the " +
    "files and memory can tell you first.",
  parameters: Parameters,
  replay: "unsafe",
  execute: (args, api, context) => executeAskUser(args, api, context).then(toolResult),
});
