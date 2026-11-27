import { Button, Input } from "@earendil-works/elanor-react";
import { type ReactNode, useState } from "react";

export type SecretRevealInputProps = {
  readonly id?: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly revealed?: boolean;
  readonly onRevealedChange?: (revealed: boolean) => void;
  readonly extraActions?: ReactNode;
  readonly "aria-label"?: string;
};

export function SecretRevealInput({
  id,
  value,
  onValueChange,
  placeholder,
  disabled = false,
  revealed,
  onRevealedChange,
  extraActions,
  "aria-label": ariaLabel,
}: SecretRevealInputProps) {
  const [internalRevealed, setInternalRevealed] = useState(false);
  const isRevealed = revealed ?? internalRevealed;

  const toggleReveal = () => {
    const next = !isRevealed;
    if (revealed === undefined) {
      setInternalRevealed(next);
    }
    onRevealedChange?.(next);
  };

  return (
    <div className="ev-key-input-row">
      <Input
        id={id}
        type={isRevealed ? "text" : "password"}
        value={value}
        disabled={disabled}
        onValueChange={onValueChange}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
      <Button type="button" hierarchy="secondary" density="compact" onClick={toggleReveal}>
        {isRevealed ? "隐藏" : "显示"}
      </Button>
      {extraActions}
    </div>
  );
}
