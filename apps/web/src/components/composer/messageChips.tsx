import {
  AutoAwesomeIcon,
  ConfirmationNumberIcon,
  DescriptionIcon,
  EngineeringIcon,
} from "@earendil-works/elanor-icons-react";
import { Chip } from "@earendil-works/elanor-react";
import type { ReactNode } from "react";
import type { MessageChip } from "../../lib/composer-value.ts";

function chipIcon(chip: MessageChip): ReactNode {
  switch (chip.kind) {
    case "file":
      return <DescriptionIcon />;
    case "worker":
      return <EngineeringIcon />;
    case "ticket":
      return <ConfirmationNumberIcon />;
    case "skill":
      return <AutoAwesomeIcon />;
  }
}

function chipLabels(chip: MessageChip): ReactNode {
  switch (chip.kind) {
    case "file":
      return chip.dir ? (
        <>
          <Chip.Label>{chip.dir}</Chip.Label>
          <Chip.Separator />
          <Chip.Label>{chip.name}</Chip.Label>
        </>
      ) : (
        <Chip.Label>{chip.name}</Chip.Label>
      );
    case "worker":
      return (
        <>
          <Chip.Label>{chip.ref}</Chip.Label>
          <Chip.Label>{chip.name}</Chip.Label>
        </>
      );
    case "ticket":
      return (
        <>
          <Chip.Label>{chip.ref}</Chip.Label>
          <Chip.Label>{chip.title}</Chip.Label>
        </>
      );
    case "skill":
      return <Chip.Label>{chip.name}</Chip.Label>;
  }
}

export function renderMessageChip(chip: MessageChip): ReactNode {
  return (
    <Chip.Root variant="soft" density="compact" title={chip.kind === "file" ? chip.ref : undefined}>
      <Chip.Icon>{chipIcon(chip)}</Chip.Icon>
      {chipLabels(chip)}
    </Chip.Root>
  );
}
