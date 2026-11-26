export function BrandLogo({ size = 20 }: { readonly size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <rect x="2" y="2" width="20" height="20" rx="6" fill="var(--ev-fg)" />
      <path
        d="M12 6.5L13.45 10.55L17.5 12L13.45 13.45L12 17.5L10.55 13.45L6.5 12L10.55 10.55L12 6.5Z"
        fill="var(--ev-bg)"
      />
    </svg>
  );
}
