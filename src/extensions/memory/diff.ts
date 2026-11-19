import type { MemoryChangeDetail, MemoryDiffLine } from "../../contracts/index.ts";

export type FileDiff = MemoryChangeDetail["files"][number];

function unquotePath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** The patch of one change, split into files, hunks and numbered lines. */
export function parseDiff(raw: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | undefined;
  let currentHunk: FileDiff["hunks"][number] | undefined;
  let oldLine = 1;
  let newLine = 1;

  const pushCurrent = () => {
    if (current) files.push(current);
    current = undefined;
    currentHunk = undefined;
  };

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      pushCurrent();
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      current = {
        path: match ? unquotePath(match[2] ?? "") : line.slice("diff --git ".length),
        status: "modified",
        added: 0,
        removed: 0,
        hunks: [],
      };
      continue;
    }

    if (!current) continue;

    if (line.startsWith("new file mode ")) {
      current.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      current.status = "deleted";
      continue;
    }
    if (line.startsWith("--- ")) {
      continue;
    }
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      if (target !== "/dev/null") {
        current.path = unquotePath(target.startsWith("b/") ? target.slice(2) : target);
      }
      continue;
    }
    if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
      current.binary = true;
      continue;
    }
    if (
      line.startsWith("index ") ||
      line.startsWith("similarity index ") ||
      line.startsWith("rename from ") ||
      line.startsWith("rename to ")
    ) {
      continue;
    }

    const hunkHeader = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkHeader) {
      oldLine = Number(hunkHeader[1]);
      newLine = Number(hunkHeader[2]);
      currentHunk = { header: line, lines: [] };
      current.hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+")) {
      currentHunk.lines.push({ kind: "add", new: newLine++, text: line.slice(1) });
      current.added++;
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({ kind: "del", old: oldLine++, text: line.slice(1) });
      current.removed++;
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({
        kind: "context",
        old: oldLine++,
        new: newLine++,
        text: line.slice(1),
      });
    }
  }

  pushCurrent();
  return files;
}

export type { MemoryDiffLine };
