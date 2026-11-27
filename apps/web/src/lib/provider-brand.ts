export type ProviderBrand =
  | "anthropic"
  | "openai"
  | "google"
  | "deepseek"
  | "xai"
  | "mistral"
  | "openrouter"
  | "groq"
  | "ollama"
  | "bedrock"
  | "azure"
  | "generic";

export function resolveProviderBrand(provider: string | undefined): ProviderBrand {
  const raw = (provider ?? "").trim().toLowerCase();
  if (!raw) return "generic";
  if (raw.includes("anthropic") || raw.includes("claude")) return "anthropic";
  if (raw.includes("openai") || raw.includes("codex")) return "openai";
  if (raw.includes("google") || raw.includes("gemini") || raw.includes("vertex")) return "google";
  if (raw.includes("deepseek")) return "deepseek";
  if (raw === "xai" || raw.includes("x-ai") || raw.includes("grok")) return "xai";
  if (raw.includes("mistral") || raw.includes("codestral")) return "mistral";
  if (raw.includes("openrouter")) return "openrouter";
  if (raw.includes("groq")) return "groq";
  if (raw.includes("ollama") || raw.includes("lmstudio") || raw.includes("local")) return "ollama";
  if (raw.includes("bedrock") || raw.includes("aws")) return "bedrock";
  if (raw.includes("azure")) return "azure";
  return "generic";
}
