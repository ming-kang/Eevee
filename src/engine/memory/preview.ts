import { structuredPatch } from "diff";
import type { FileDiff } from "./diff.ts";

export function previewFiles(
  before: Map<string, string | undefined>,
  after: Map<string, string | undefined>,
): FileDiff[] {
  const files: FileDiff[] = [];
  for (const [path, content] of after) {
    const original = before.get(path);
    if (original === content) continue;
    const patch = structuredPatch(path, path, original ?? "", content ?? "");
    let added = 0,
      removed = 0;
    const hunks = patch.hunks.map((hunk) => {
      let old = hunk.oldStart,
        next = hunk.newStart;
      const lines: FileDiff["hunks"][number]["lines"] = [];
      for (const line of hunk.lines) {
        if (line[0] === "+") {
          lines.push({ kind: "add", new: next++, text: line.slice(1) });
          added++;
        } else if (line[0] === "-") {
          lines.push({ kind: "del", old: old++, text: line.slice(1) });
          removed++;
        } else if (line[0] === " ")
          lines.push({ kind: "context", old: old++, new: next++, text: line.slice(1) });
      }
      return {
        header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
        lines,
      };
    });
    files.push({
      path,
      status: original === undefined ? "added" : content === undefined ? "deleted" : "modified",
      added,
      removed,
      hunks,
    });
  }
  return files;
}
