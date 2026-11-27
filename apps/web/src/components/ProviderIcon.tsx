import { resolveProviderBrand } from "../lib/provider-brand.ts";

export { type ProviderBrand, resolveProviderBrand } from "../lib/provider-brand.ts";

export function ProviderIcon({
  provider,
  size = 14,
  className,
}: {
  readonly provider?: string;
  readonly size?: number;
  readonly className?: string;
}) {
  const brand = resolveProviderBrand(provider);
  const cls = className ? `ev-provider-icon ${className}` : "ev-provider-icon";

  switch (brand) {
    case "anthropic":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 16 16"
          fill="none"
          className={cls}
          aria-hidden="true"
        >
          <path
            d="M5.7 13L3.1 13L7.1 3H9.1L5.7 13ZM10.4 3L14.2 13H11.9L11.1 10.7H7.7L8.4 8.8H10.4L9.2 5.3L10.4 3Z"
            fill="currentColor"
          />
        </svg>
      );
    case "openai":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 16 16"
          fill="none"
          className={cls}
          aria-hidden="true"
        >
          <path
            d="M8 2.1a2.9 2.9 0 0 1 2.55 1.52 2.9 2.9 0 0 1 3.3 4.33 2.9 2.9 0 0 1-1.95 4.95 2.9 2.9 0 0 1-3.9 1A2.9 2.9 0 0 1 5.45 12.38a2.9 2.9 0 0 1-3.3-4.33 2.9 2.9 0 0 1 1.95-4.95A2.9 2.9 0 0 1 8 2.1Z"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinejoin="round"
          />
          <circle cx="8" cy="8" r="2.1" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      );
    case "google":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 16 16"
          fill="none"
          className={cls}
          aria-hidden="true"
        >
          <path
            d="M8 1.6C8.55 5.05 10.95 7.45 14.4 8C10.95 8.55 8.55 10.95 8 14.4C7.45 10.95 5.05 8.55 1.6 8C5.05 7.45 7.45 5.05 8 1.6Z"
            fill="currentColor"
          />
        </svg>
      );
    case "deepseek":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 16 16"
          fill="none"
          className={cls}
          aria-hidden="true"
        >
          <path
            d="M2.5 9.2c0-2.9 2.3-5.2 5.4-5.2 2.4 0 4.4 1.3 5.3 3.3l.8-1.1c.2 1.8-.3 3.5-1.5 4.7-1.2 1.2-2.9 1.9-4.8 1.9-2.9 0-5.2-1.5-5.2-3.6Z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
          <circle cx="6.2" cy="8.1" r="1" fill="currentColor" />
        </svg>
      );
    case "xai":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 16 16"
          fill="none"
          className={cls}
          aria-hidden="true"
        >
          <path
            d="M3 3L13 13M13 3L3 13"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
        </svg>
      );
    case "mistral":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 16 16"
          fill="none"
          className={cls}
          aria-hidden="true"
        >
          <path
            d="M2.5 3.5H5v2.2h1.9V8h2.2V5.7H11V3.5h2.5v9H11V8.8H9.1V11H6.9V8.8H5v3.7H2.5v-9Z"
            fill="currentColor"
          />
        </svg>
      );
    case "openrouter":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 16 16"
          fill="none"
          className={cls}
          aria-hidden="true"
        >
          <path
            d="M2.5 8h4.2l3.2-3.2h3.6M6.7 8l3.2 3.2h3.6"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="13" cy="4.8" r="1.2" fill="currentColor" />
          <circle cx="13" cy="11.2" r="1.2" fill="currentColor" />
          <circle cx="2.8" cy="8" r="1.2" fill="currentColor" />
        </svg>
      );
    case "groq":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 16 16"
          fill="none"
          className={cls}
          aria-hidden="true"
        >
          <path
            d="M12.2 6.2A4.5 4.5 0 1 0 12.5 8H8.6"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      );
    case "ollama":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 16 16"
          fill="none"
          className={cls}
          aria-hidden="true"
        >
          <rect
            x="3"
            y="4"
            width="10"
            height="8.5"
            rx="3.5"
            stroke="currentColor"
            strokeWidth="1.35"
          />
          <circle cx="6.2" cy="8.2" r="0.9" fill="currentColor" />
          <circle cx="9.8" cy="8.2" r="0.9" fill="currentColor" />
        </svg>
      );
    case "bedrock":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 16 16"
          fill="none"
          className={cls}
          aria-hidden="true"
        >
          <path
            d="M8 2.2L13 5v6l-5 2.8L3 11V5l5-2.8Z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
          <path d="M8 8v5.8M8 8L13 5M8 8L3 5" stroke="currentColor" strokeWidth="1.15" />
        </svg>
      );
    case "azure":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 16 16"
          fill="none"
          className={cls}
          aria-hidden="true"
        >
          <path
            d="M4.2 12.6L8.3 3.2L12.6 12.6H9.7L8.3 9.2L6.6 12.6H4.2Z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
        </svg>
      );
    default:
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 16 16"
          fill="none"
          className={cls}
          aria-hidden="true"
        >
          <rect
            x="3"
            y="3"
            width="10"
            height="10"
            rx="2.6"
            stroke="currentColor"
            strokeWidth="1.3"
          />
          <circle cx="8" cy="8" r="1.8" fill="currentColor" />
        </svg>
      );
  }
}
