import { CloseIcon, SearchIcon } from "@earendil-works/elanor-icons-react";
import type { KeyboardEvent, Ref } from "react";
import { useI18n } from "../lib/i18n.ts";

export type SearchFieldProps = {
  readonly ref?: Ref<HTMLInputElement>;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder: string;
  readonly ariaLabel?: string;
  readonly className?: string;
  readonly size?: "default" | "compact";
  readonly clearOnEscape?: boolean;
  readonly onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
};

export function SearchField({
  ref,
  value,
  onChange,
  placeholder,
  ariaLabel,
  className,
  size = "default",
  clearOnEscape = false,
  onKeyDown,
}: SearchFieldProps) {
  const { t } = useI18n();
  const classes = ["ev-search-field", size === "compact" ? "compact" : undefined, className]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes}>
      <SearchIcon width={size === "compact" ? 14 : 15} height={size === "compact" ? 14 : 15} />
      <input
        ref={ref}
        className="ev-raw-input"
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (clearOnEscape && !event.nativeEvent.isComposing && event.key === "Escape" && value) {
            event.preventDefault();
            event.stopPropagation();
            onChange("");
            return;
          }
          onKeyDown?.(event);
        }}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        autoComplete="off"
      />
      {value !== "" && (
        <button
          type="button"
          className="ev-search-clear"
          aria-label={t("common.clear")}
          onClick={() => onChange("")}
        >
          <CloseIcon width={12} height={12} />
        </button>
      )}
    </div>
  );
}
