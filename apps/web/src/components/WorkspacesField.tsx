import { AddIcon, CloseIcon, FolderIcon, FolderOpenIcon } from "@earendil-works/elanor-icons-react";
import { Button, Field, IconButton, Input } from "@earendil-works/elanor-react";
import { EeveeApiError } from "@eevee/protocol";
import { type KeyboardEvent, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { useI18n } from "../lib/i18n.ts";

export function mergeWorkspacePaths(
  existing: readonly string[],
  rawInput: string,
): { readonly next: string[]; readonly added: number; readonly hadDuplicate: boolean } {
  const candidates = rawInput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (candidates.length === 0) {
    return { next: [...existing], added: 0, hadDuplicate: false };
  }
  const seen = new Set(existing);
  const next = [...existing];
  let added = 0;
  let hadDuplicate = false;
  for (const item of candidates) {
    if (seen.has(item)) {
      hadDuplicate = true;
      continue;
    }
    seen.add(item);
    next.push(item);
    added += 1;
  }
  return { next, added, hadDuplicate };
}

export type WorkspacesFieldProps = {
  readonly value: readonly string[];
  readonly onChange: (next: string[]) => void;
  readonly pendingPath: string;
  readonly onPendingPathChange: (next: string) => void;
  readonly disabled?: boolean;
};

export function WorkspacesField({
  value,
  onChange,
  pendingPath,
  onPendingPathChange,
  disabled = false,
}: WorkspacesFieldProps) {
  const { t } = useI18n();
  const [picking, setPicking] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const inputWrapRef = useRef<HTMLDivElement | null>(null);

  const commitPending = () => {
    const merged = mergeWorkspacePaths(value, pendingPath);
    if (merged.added > 0) {
      onChange(merged.next);
      onPendingPathChange("");
      setNotice(merged.hadDuplicate ? t("project.workspace.duplicate") : undefined);
    } else if (merged.hadDuplicate) {
      setNotice(t("project.workspace.duplicate"));
    }
  };

  const handlePick = async () => {
    if (disabled || picking) return;
    setPicking(true);
    setNotice(undefined);
    try {
      const lastDir = value[value.length - 1];
      const res = await api.pickDirectory({
        title: t("project.workspace.pick"),
        ...(lastDir ? { initialPath: lastDir } : {}),
      });
      if (!res.cancelled && res.path) {
        const merged = mergeWorkspacePaths(value, res.path);
        if (merged.added > 0) {
          onChange(merged.next);
        } else if (merged.hadDuplicate) {
          setNotice(t("project.workspace.duplicate"));
        }
      }
    } catch (err) {
      if (err instanceof EeveeApiError && err.problem.code === "picker_unavailable") {
        setNotice(t("project.workspace.pickerUnavailable"));
        inputWrapRef.current?.querySelector("input")?.focus();
      } else if (err instanceof EeveeApiError && err.problem.code === "picker_busy") {
        setNotice(t("project.workspace.pickerBusy"));
      } else {
        setNotice(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setPicking(false);
    }
  };

  const handleRemove = (target: string) => {
    onChange(value.filter((item) => item !== target));
    setNotice(undefined);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && pendingPath.trim().length > 0) {
      event.preventDefault();
      commitPending();
    }
  };

  return (
    <Field.Root>
      <Field.Label>{t("project.field.workspaces")}</Field.Label>
      <div className="ev-workspaces-field">
        {value.length > 0 && (
          <div className="ev-workspaces-list">
            {value.map((dir) => (
              <div key={dir} className="ev-workspace-row">
                <FolderIcon width={14} height={14} className="ev-workspace-row-icon" />
                <span className="ev-mono ev-truncate ev-workspace-row-path" title={dir}>
                  {dir}
                </span>
                <IconButton
                  type="button"
                  aria-label={t("project.workspace.remove")}
                  title={t("project.workspace.remove")}
                  disabled={disabled}
                  onClick={() => handleRemove(dir)}
                >
                  <CloseIcon width={14} height={14} />
                </IconButton>
              </div>
            ))}
          </div>
        )}

        <div className="ev-workspaces-controls" ref={inputWrapRef}>
          <Button
            type="button"
            hierarchy="secondary"
            density="compact"
            iconStart={<FolderOpenIcon width={15} height={15} />}
            disabled={disabled}
            pending={picking}
            onClick={() => void handlePick()}
          >
            {picking ? t("project.workspace.picking") : t("project.workspace.pick")}
          </Button>
          <div className="ev-workspaces-input-wrap">
            <Input
              type="text"
              value={pendingPath}
              disabled={disabled}
              onKeyDown={handleKeyDown}
              onValueChange={(next) => {
                onPendingPathChange(next);
                if (notice) setNotice(undefined);
              }}
              placeholder={t("project.workspace.addPathPlaceholder")}
            />
          </div>
          <Button
            type="button"
            hierarchy="secondary"
            density="compact"
            iconStart={<AddIcon width={15} height={15} />}
            disabled={disabled || pendingPath.trim().length === 0}
            onClick={commitPending}
          >
            {t("project.workspace.addPath")}
          </Button>
        </div>

        {notice && <p className="ev-inline-error">{notice}</p>}
      </div>
    </Field.Root>
  );
}
