import { CheckIcon } from "@earendil-works/elanor-icons-react";
import { Dropdown } from "@earendil-works/elanor-react";
import { useMemo } from "react";

export type DropdownOption = {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
};

export type EvDropdownProps = {
  readonly value: string;
  readonly options: readonly DropdownOption[];
  readonly onChange: (value: string) => void;
  readonly ariaLabel?: string;
  readonly placeholder?: string;
  readonly density?: "compact" | "default";
  readonly disabled?: boolean;
  readonly className?: string;
  readonly align?: "start" | "center" | "end";
};

export function EvDropdown({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder,
  density = "compact",
  disabled = false,
  className,
  align = "start",
}: EvDropdownProps) {
  const itemsMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const opt of options) {
      map[opt.value] = opt.label;
    }
    return map;
  }, [options]);

  const selectedOption = options.find((opt) => opt.value === value);
  const triggerClass = ["ev-dropdown-trigger", className].filter(Boolean).join(" ");

  return (
    <Dropdown.Root<string>
      value={value}
      items={itemsMap}
      disabled={disabled}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next);
      }}
    >
      <Dropdown.Trigger
        density={density}
        className={triggerClass}
        aria-label={ariaLabel}
        disabled={disabled}
      >
        <Dropdown.Value className="ev-truncate">
          {selectedOption?.label ?? placeholder ?? value}
        </Dropdown.Value>
        <Dropdown.Icon />
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Positioner className="ev-dropdown-positioner" align={align} sideOffset={4}>
          <Dropdown.Popup className="ev-dropdown-popup">
            <Dropdown.List>
              {options.map((opt) => (
                <Dropdown.Item
                  key={opt.value}
                  value={opt.value}
                  disabled={opt.disabled}
                  className="ev-dropdown-item"
                >
                  <Dropdown.ItemIndicator>
                    <CheckIcon width={13} height={13} />
                  </Dropdown.ItemIndicator>
                  <Dropdown.ItemText className="ev-dropdown-item-text">
                    <span>{opt.label}</span>
                    {opt.description && (
                      <span className="ev-dropdown-item-desc">{opt.description}</span>
                    )}
                  </Dropdown.ItemText>
                </Dropdown.Item>
              ))}
            </Dropdown.List>
          </Dropdown.Popup>
        </Dropdown.Positioner>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
