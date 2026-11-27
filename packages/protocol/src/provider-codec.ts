import type { ConnectionNote } from "./schemas/models.ts";

export function validateProviderBaseUrl(raw: string): string | undefined {
  if (raw.trim().length === 0) return "Base URL is required";
  if (raw !== raw.trim()) return "Base URL must not have leading or trailing whitespace";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Base URL must be an absolute URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Base URL must use http or https";
  }
  if (url.username || url.password) return "Base URL must not contain credentials";
  if (url.search || url.hash) return "Base URL must not contain a query string or fragment";
  return undefined;
}

export function providerBaseUrlPlaceholder(api?: string): string {
  switch (api) {
    case "anthropic-messages":
      return "https://api.anthropic.com";
    case "azure-openai-responses":
      return "https://RESOURCE.openai.azure.com/openai/v1";
    case "google-generative-ai":
      return "https://generativelanguage.googleapis.com/v1beta";
    case "google-vertex":
      return "https://REGION-aiplatform.googleapis.com/v1";
    case "bedrock-converse-stream":
      return "https://bedrock-runtime.REGION.amazonaws.com";
    default:
      return "https://api.example.com/v1";
  }
}

export function describeProviderConnectionUrl(baseUrl: string, api?: string): string | undefined {
  if (validateProviderBaseUrl(baseUrl) !== undefined) return undefined;
  const url = new URL(baseUrl);
  url.search = "";
  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "");
  if (api === "anthropic-messages" && !/\/v1(?:\/anthropic)?$/i.test(path)) {
    url.pathname = `${path}/v1/models`.replace(/^\/\//, "/");
  } else {
    url.pathname = `${path}/models`.replace(/^\/\//, "/");
  }
  return url.toString();
}

export function describeProviderConnectionNote(
  baseUrl: string | undefined,
  api?: string,
): ConnectionNote | undefined {
  if (baseUrl === undefined) return undefined;
  const text = describeProviderConnectionUrl(baseUrl, api);
  if (text === undefined) return undefined;
  const doubledV1 = /\/v1\/v1(?:\/|$)/i.test(new URL(text).pathname);
  return {
    text,
    ...(doubledV1 ? { warning: true } : {}),
  };
}
