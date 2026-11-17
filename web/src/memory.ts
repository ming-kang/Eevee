export type MemoryAuthor = "dreaming" | "router" | "user" | "eevee";

export type GitDiffLine = {
  k: "ctx" | "add" | "del";
  o?: number;
  n?: number;
  s: string;
};

export type GitDiffHunk = {
  head: string;
  lines: GitDiffLine[];
};

export type GitFileDiff = {
  file: string;
  newFile?: boolean;
  deletedFile?: boolean;
  binary?: boolean;
  hunks: GitDiffHunk[];
  added: number;
  removed: number;
};

export function classifyCommitAuthor(subject: string): MemoryAuthor {
  const trimmed = subject.trim();
  if (trimmed.startsWith("dreaming")) return "dreaming";
  if (trimmed === "user edit" || trimmed.startsWith("user edit:")) return "user";
  if (trimmed === "memory: init" || trimmed.startsWith("Revert ")) return "eevee";
  return "router";
}

function unquoteGitPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseGitDiff(raw: string): GitFileDiff[] {
  const files: GitFileDiff[] = [];
  let current: GitFileDiff | undefined;
  let currentHunk: GitDiffHunk | undefined;
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
        file: match ? unquoteGitPath(match[2] ?? "") : line.slice("diff --git ".length),
        hunks: [],
        added: 0,
        removed: 0,
      };
      continue;
    }

    if (!current) continue;

    if (line.startsWith("new file mode ")) {
      current.newFile = true;
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      current.deletedFile = true;
      continue;
    }
    if (line.startsWith("--- ")) {
      continue;
    }
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      if (target !== "/dev/null") {
        current.file = unquoteGitPath(target.startsWith("b/") ? target.slice(2) : target);
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
      currentHunk = { head: line, lines: [] };
      current.hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+")) {
      currentHunk.lines.push({ k: "add", n: newLine++, s: line.slice(1) });
      current.added++;
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({ k: "del", o: oldLine++, s: line.slice(1) });
      current.removed++;
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({ k: "ctx", o: oldLine++, n: newLine++, s: line.slice(1) });
    }
  }

  pushCurrent();
  return files;
}
