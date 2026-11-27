export const AUTH_HEADERS = {
  authorization: "Authorization",
  anthropic: "x-api-key",
  google: "x-goog-api-key",
  cloudflare: "cf-aig-authorization",
} as const;

export const REQUEST_AUTH_HEADER_NAMES: ReadonlySet<string> = new Set(
  Object.values(AUTH_HEADERS).map((name) => name.toLowerCase()),
);
