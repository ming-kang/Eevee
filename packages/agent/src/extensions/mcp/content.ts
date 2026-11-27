import type { JsonObject } from "@earendil-works/pi-durable";
import type {
  BlobResourceContents,
  LlmContent,
  McpOutputSaver,
  TextResourceContents,
} from "@earendil-works/pi-mcp";
import { errorMessage } from "../../shared/guards.ts";
import { formatSize } from "../../shared/truncate.ts";

export type ResourceContentItem = TextResourceContents | BlobResourceContents;

export type ConvertedResourceContent = {
  readonly modelBlock: LlmContent;
  readonly structured: JsonObject;
  readonly savedPath?: string;
};

export type ConvertResourceContentOptions = {
  readonly saveOutput?: McpOutputSaver;
  readonly defaultBinaryMimeType?: string;
  readonly catchSaveError?: boolean;
};

export function extensionOf(uri: string): string {
  const path = URL.canParse(uri) ? new URL(uri).pathname : uri;
  return /\.[A-Za-z0-9]{1,8}$/.exec(path)?.[0] ?? ".bin";
}

export function isTextMimeType(mimeType: string | undefined): boolean {
  if (mimeType === undefined) return false;
  const type = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/xml" ||
    type.endsWith("+json") ||
    type.endsWith("+xml")
  );
}

export async function resourceContentToLlm(
  item: ResourceContentItem,
  options: ConvertResourceContentOptions = {},
): Promise<ConvertedResourceContent> {
  if ("text" in item) {
    const structured: JsonObject = { uri: item.uri, text: item.text };
    if (item.mimeType !== undefined) structured.mimeType = item.mimeType;
    return {
      modelBlock: { type: "text", text: item.text },
      structured,
    };
  }

  if (item.mimeType?.startsWith("image/")) {
    return {
      modelBlock: { type: "image", data: item.blob, mimeType: item.mimeType },
      structured: {
        uri: item.uri,
        mimeType: item.mimeType,
        encoding: "base64",
        data: item.blob,
      },
    };
  }

  const data = Buffer.from(item.blob, "base64");
  if (isTextMimeType(item.mimeType)) {
    const text = data.toString("utf8");
    const structured: JsonObject = { uri: item.uri, text };
    if (item.mimeType !== undefined) structured.mimeType = item.mimeType;
    return {
      modelBlock: { type: "text", text },
      structured,
    };
  }

  const fallbackMime = options.defaultBinaryMimeType ?? "application/octet-stream";
  const kind = `${item.mimeType ?? fallbackMime}, ${formatSize(data.length)}`;
  const structured: JsonObject = { uri: item.uri, size: data.length };
  if (item.mimeType !== undefined) structured.mimeType = item.mimeType;

  if (options.saveOutput === undefined) {
    return {
      modelBlock: {
        type: "text",
        text: `[Binary resource ${item.uri} (${kind}) omitted]`,
      },
      structured,
    };
  }

  try {
    const savedPath = await options.saveOutput(data, extensionOf(item.uri));
    structured.savedPath = savedPath;
    return {
      modelBlock: {
        type: "text",
        text: `[Binary resource ${item.uri} (${kind}) saved to ${savedPath}]`,
      },
      structured,
      savedPath,
    };
  } catch (error) {
    if (!options.catchSaveError) throw error;
    return {
      modelBlock: {
        type: "text",
        text: `[Binary resource ${item.uri} (${kind}) could not be saved: ${errorMessage(error)}]`,
      },
      structured,
    };
  }
}
