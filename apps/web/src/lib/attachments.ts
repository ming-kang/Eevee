import {
  MAX_ATTACHMENT_BYTES,
  MAX_MESSAGE_ATTACHMENTS,
  type MessageAttachment,
} from "@eevee/protocol";

export type DraftAttachment = {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly data: string;
  readonly previewUrl?: string;
};

export type AttachmentValidationIssue =
  | { readonly kind: "too_many"; readonly max: number }
  | { readonly kind: "too_large"; readonly name: string; readonly maxBytes: number }
  | { readonly kind: "read_error"; readonly name: string };

const attachmentDrafts = new Map<string, readonly DraftAttachment[]>();
let nextAttachmentId = 1;

export function getDraftAttachments(draftKey: string): readonly DraftAttachment[] {
  return attachmentDrafts.get(draftKey) ?? [];
}

export function setDraftAttachments(
  draftKey: string,
  attachments: readonly DraftAttachment[],
): void {
  if (attachments.length === 0) attachmentDrafts.delete(draftKey);
  else attachmentDrafts.set(draftKey, attachments);
}

export function restoreFailedAttachments(
  draftKey: string,
  submitted: readonly DraftAttachment[],
): readonly DraftAttachment[] {
  const current = getDraftAttachments(draftKey);
  const merged = [...submitted, ...current].slice(0, MAX_MESSAGE_ATTACHMENTS);
  setDraftAttachments(draftKey, merged);
  return merged;
}

export function toProtocolAttachments(
  attachments: readonly DraftAttachment[],
): MessageAttachment[] {
  return attachments.map((item) => ({
    kind: "inline",
    name: item.name,
    mimeType: item.mimeType,
    data: item.data,
  }));
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Unexpected FileReader result"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(file);
  });
}

function inferMimeType(file: File): string {
  if (file.type && file.type.trim().length > 0) return file.type;
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "text/typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx")) return "text/javascript";
  return "application/octet-stream";
}

export async function readFilesAsDraftAttachments(
  files: FileList | readonly File[],
  existingCount: number,
): Promise<{
  readonly attachments: DraftAttachment[];
  readonly issues: AttachmentValidationIssue[];
}> {
  const list = Array.from(files);
  const attachments: DraftAttachment[] = [];
  const issues: AttachmentValidationIssue[] = [];
  let remaining = Math.max(0, MAX_MESSAGE_ATTACHMENTS - existingCount);

  for (const file of list) {
    if (remaining <= 0) {
      issues.push({ kind: "too_many", max: MAX_MESSAGE_ATTACHMENTS });
      break;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      issues.push({ kind: "too_large", name: file.name, maxBytes: MAX_ATTACHMENT_BYTES });
      continue;
    }
    try {
      const dataUrl = await readAsDataUrl(file);
      const comma = dataUrl.indexOf(",");
      if (comma === -1) {
        issues.push({ kind: "read_error", name: file.name });
        continue;
      }
      const data = dataUrl.slice(comma + 1);
      const mimeType = inferMimeType(file);
      const isImage = mimeType.startsWith("image/");
      attachments.push({
        id: `att-${nextAttachmentId++}`,
        name: file.name || (isImage ? "pasted-image.png" : "file"),
        mimeType,
        size: file.size,
        data,
        ...(isImage ? { previewUrl: `data:${mimeType};base64,${data}` } : {}),
      });
      remaining -= 1;
    } catch {
      issues.push({ kind: "read_error", name: file.name });
    }
  }

  return { attachments, issues };
}
