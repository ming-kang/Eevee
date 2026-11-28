import { Composer } from "@earendil-works/elanor-react";
import type { KeyboardEvent } from "react";
import type { MessageChip, MessageValue } from "../../lib/composer-value.ts";

const PROMPT_MAX_ROWS = 8;

function isModifiedEnter(event: KeyboardEvent<HTMLDivElement>): boolean {
  return (
    event.key === "Enter" &&
    !event.shiftKey &&
    (event.metaKey || event.ctrlKey) &&
    !event.nativeEvent.isComposing &&
    !event.currentTarget.hasAttribute("data-popup-open")
  );
}

export function MessagePrompt({
  placeholder,
  sentMessages,
}: {
  readonly placeholder: string;
  readonly sentMessages: readonly MessageValue[];
}) {
  const recall = Composer.useRecall(sentMessages);
  const { submit } = Composer.useActions<MessageChip>();

  return (
    <Composer.Prompt
      className="ev-composer-prompt"
      aria-label={placeholder}
      placeholder={placeholder}
      maxRows={PROMPT_MAX_ROWS}
      onKeyDown={(event) => {
        if (isModifiedEnter(event)) {
          event.preventDefault();
          submit(event.nativeEvent);
          return;
        }
        recall(event);
      }}
    />
  );
}
