import { useCallback, useEffect, useRef, useState } from "react";
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
  appendSentHistory,
  readDraft,
  readSentHistory,
  restoreFailedDraft,
  restoreFailedDraftToStorage,
  writeDraft,
} from "../../lib/composer-draft.ts";
import type { MessageValue } from "../../lib/composer-value.ts";
import { formatBytes } from "../../lib/format.ts";
import { useI18n } from "../../lib/i18n.ts";
import { showToast } from "../../lib/toasts.ts";

function readStoredDraft(draftKey: string): MessageValue {
  try {
    return readDraft(window.localStorage, draftKey);
  } catch {
    return [];
  }
}

function readStoredHistory(draftKey: string): MessageValue[] {
  try {
    return readSentHistory(window.localStorage, draftKey);
  } catch {
    return [];
  }
}

export function useComposerDraft(draftKey: string, disabled: boolean) {
  const { t } = useI18n();
  const [value, setValue] = useState<MessageValue>(() => readStoredDraft(draftKey));
  const [attachments, setAttachmentsState] = useState<readonly DraftAttachment[]>(() =>
    getDraftAttachments(draftKey),
  );
  const [sentHistory, setSentHistory] = useState<readonly MessageValue[]>(() =>
    readStoredHistory(draftKey),
  );

  const valueRef = useRef(value);
  valueRef.current = value;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    draftKeyRef.current = draftKey;
    const nextValue = readStoredDraft(draftKey);
    const nextAttachments = getDraftAttachments(draftKey);
    valueRef.current = nextValue;
    attachmentsRef.current = nextAttachments;
    setValue(nextValue);
    setAttachmentsState(nextAttachments);
    setSentHistory(readStoredHistory(draftKey));
  }, [draftKey]);

  const updateValue = useCallback((next: MessageValue) => {
    valueRef.current = next;
    setValue(next);
    try {
      writeDraft(window.localStorage, draftKeyRef.current, next);
    } catch {}
  }, []);

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
    async (files: readonly File[]) => {
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

  const pastedValue = useCallback(
    (text: string): MessageValue => {
      if (!shouldConvertPasteToAttachment(text)) return [text];
      const { attachment, issue } = createPastedTextAttachment(text, attachmentsRef.current);
      if (issue) {
        reportAttachmentIssues([issue]);
        return [text];
      }
      if (!attachment) return [text];
      updateAttachments([...attachmentsRef.current, attachment]);
      showToast(t("composer.attachment.pastedToFile", { name: attachment.name }));
      return [];
    },
    [reportAttachmentIssues, updateAttachments, t],
  );

  const recordSent = useCallback((sentDraftKey: string, sent: MessageValue) => {
    try {
      const next = appendSentHistory(window.localStorage, sentDraftKey, sent);
      if (mountedRef.current && draftKeyRef.current === sentDraftKey) setSentHistory(next);
    } catch {}
  }, []);

  const restoreSubmitted = useCallback(
    (
      submittedDraftKey: string,
      submittedValue: MessageValue,
      submittedAttachments: readonly DraftAttachment[],
    ): boolean => {
      if (mountedRef.current && draftKeyRef.current === submittedDraftKey) {
        updateValue(restoreFailedDraft(submittedValue, valueRef.current));
        if (submittedAttachments.length > 0) {
          const restoredAtts = restoreFailedAttachments(submittedDraftKey, submittedAttachments);
          attachmentsRef.current = restoredAtts;
          setAttachmentsState(restoredAtts);
        }
        return true;
      }
      try {
        restoreFailedDraftToStorage(window.localStorage, submittedDraftKey, submittedValue);
      } catch {}
      if (submittedAttachments.length > 0) {
        restoreFailedAttachments(submittedDraftKey, submittedAttachments);
      }
      return false;
    },
    [updateValue],
  );

  return {
    value,
    attachments,
    attachmentsRef,
    sentHistory,
    mountedRef,
    updateValue,
    updateAttachments,
    appendFiles,
    pastedValue,
    recordSent,
    restoreSubmitted,
  };
}
