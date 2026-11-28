import {
  type ClipboardEvent,
  type DragEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type AttachmentValidationIssue,
  createPastedTextAttachment,
  type DraftAttachment,
  getDraftAttachments,
  readFilesAsDraftAttachments,
  restoreFailedAttachments,
  setDraftAttachments,
  shouldConvertPasteToAttachment,
} from "../../lib/attachments.ts";
import {
  readDraft,
  restoreFailedDraft,
  restoreFailedDraftToStorage,
  writeDraft,
} from "../../lib/composer-draft.ts";
import { messageText } from "../../lib/composer-value.ts";
import { formatBytes } from "../../lib/format.ts";
import { useI18n } from "../../lib/i18n.ts";
import { showToast } from "../../lib/toasts.ts";

function readStoredDraft(draftKey: string): string {
  try {
    return messageText(readDraft(window.localStorage, draftKey));
  } catch {
    return "";
  }
}

export function useComposerDraft(draftKey: string, disabled: boolean) {
  const { t } = useI18n();
  const [text, setText] = useState(() => readStoredDraft(draftKey));
  const [attachments, setAttachmentsState] = useState<readonly DraftAttachment[]>(() =>
    getDraftAttachments(draftKey),
  );
  const [dragging, setDragging] = useState(false);

  const textRef = useRef(text);
  textRef.current = text;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;
  const mountedRef = useRef(true);
  const dragDepthRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    draftKeyRef.current = draftKey;
    const nextDraft = readStoredDraft(draftKey);
    const nextAttachments = getDraftAttachments(draftKey);
    textRef.current = nextDraft;
    attachmentsRef.current = nextAttachments;
    setText(nextDraft);
    setAttachmentsState(nextAttachments);
  }, [draftKey]);

  const updateText = useCallback(
    (next: string) => {
      textRef.current = next;
      setText(next);
      try {
        writeDraft(window.localStorage, draftKey, next ? [next] : []);
      } catch {}
    },
    [draftKey],
  );

  const updateAttachments = useCallback((next: readonly DraftAttachment[]) => {
    attachmentsRef.current = next;
    setAttachmentsState(next);
    setDraftAttachments(draftKeyRef.current, next);
  }, []);

  const reportAttachmentIssues = useCallback(
    (issues: readonly AttachmentValidationIssue[]) => {
      for (const issue of issues) {
        if (issue.kind === "too_many") {
          showToast(t("composer.attachment.tooMany", { max: issue.max }), "danger");
        } else if (issue.kind === "too_large") {
          showToast(
            t("composer.attachment.tooLarge", {
              name: issue.name,
              max: formatBytes(issue.maxBytes),
            }),
            "danger",
          );
        } else {
          showToast(t("composer.attachment.readError", { name: issue.name }), "danger");
        }
      }
    },
    [t],
  );

  const appendFiles = useCallback(
    async (files: FileList | readonly File[]) => {
      if (disabled || files.length === 0) return;
      const result = await readFilesAsDraftAttachments(files, attachmentsRef.current.length);
      if (!mountedRef.current) return;
      if (result.attachments.length > 0) {
        updateAttachments([...attachmentsRef.current, ...result.attachments]);
      }
      if (result.issues.length > 0) {
        reportAttachmentIssues(result.issues);
      }
    },
    [disabled, updateAttachments, reportAttachmentIssues],
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = event.clipboardData?.items;
      if (items) {
        const pastedFiles: File[] = [];
        for (const item of Array.from(items)) {
          if (item.kind === "file") {
            const file = item.getAsFile();
            if (file) pastedFiles.push(file);
          }
        }
        if (pastedFiles.length > 0) {
          event.preventDefault();
          void appendFiles(pastedFiles);
          return;
        }
      }
      if (disabled) return;
      const plain = event.clipboardData?.getData("text/plain") ?? "";
      if (!shouldConvertPasteToAttachment(plain)) return;
      const { attachment, issue } = createPastedTextAttachment(plain, attachmentsRef.current);
      if (issue) {
        reportAttachmentIssues([issue]);
        return;
      }
      if (!attachment) return;
      event.preventDefault();
      updateAttachments([...attachmentsRef.current, attachment]);
      showToast(t("composer.attachment.pastedToFile", { name: attachment.name }));
    },
    [appendFiles, disabled, reportAttachmentIssues, updateAttachments, t],
  );

  const expandAttachmentToText = useCallback(
    (id: string) => {
      const target = attachmentsRef.current.find((a) => a.id === id);
      if (!target || target.pastedText === undefined) return;
      const current = textRef.current;
      const sep = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
      updateText(`${current}${sep}${target.pastedText}`);
      updateAttachments(attachmentsRef.current.filter((a) => a.id !== id));
    },
    [updateText, updateAttachments],
  );

  const handleDragEnter = useCallback((event: DragEvent<HTMLFormElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragging(true);
  }, []);

  const handleDragOver = useCallback((event: DragEvent<HTMLFormElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLFormElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragging(false);
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLFormElement>) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      dragDepthRef.current = 0;
      setDragging(false);
      if (event.dataTransfer.files.length > 0) {
        void appendFiles(event.dataTransfer.files);
      }
    },
    [appendFiles],
  );

  const restoreSubmitted = useCallback(
    (
      submittedDraftKey: string,
      submittedText: string,
      submittedAttachments: readonly DraftAttachment[],
    ): { readonly restoredCurrent: boolean; readonly cursorToEnd?: number } => {
      if (mountedRef.current && draftKeyRef.current === submittedDraftKey) {
        const wasEmpty = textRef.current === "";
        const restored = messageText(
          restoreFailedDraft([submittedText], textRef.current ? [textRef.current] : []),
        );
        updateText(restored);
        if (submittedAttachments.length > 0) {
          const restoredAtts = restoreFailedAttachments(submittedDraftKey, submittedAttachments);
          attachmentsRef.current = restoredAtts;
          setAttachmentsState(restoredAtts);
        }
        return { restoredCurrent: true, ...(wasEmpty ? { cursorToEnd: restored.length } : {}) };
      }
      try {
        restoreFailedDraftToStorage(window.localStorage, submittedDraftKey, [submittedText]);
      } catch {}
      if (submittedAttachments.length > 0) {
        restoreFailedAttachments(submittedDraftKey, submittedAttachments);
      }
      return { restoredCurrent: false };
    },
    [updateText],
  );

  return {
    text,
    textRef,
    attachments,
    attachmentsRef,
    dragging,
    mountedRef,
    updateText,
    updateAttachments,
    appendFiles,
    expandAttachmentToText,
    handlePaste,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    restoreSubmitted,
  };
}
