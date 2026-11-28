import type { SkillEntry } from "@eevee/protocol";

export type CodeRange = {
  readonly start: number;
  readonly end: number;
};

function isEscapedByBackslash(text: string, index: number): boolean {
  let count = 0;
  for (let pos = index - 1; pos >= 0 && text[pos] === "\\"; pos--) {
    count++;
  }
  return count % 2 === 1;
}

export function findCodeRanges(text: string): CodeRange[] {
  const ranges: CodeRange[] = [];
  let index = 0;
  let atLineStart = true;

  while (index < text.length) {
    if (atLineStart) {
      let spaces = 0;
      let pos = index;
      while (spaces < 3 && pos < text.length && text[pos] === " ") {
        spaces++;
        pos++;
      }
      const fenceChar = text[pos];
      if (fenceChar === "`" || fenceChar === "~") {
        let fenceLen = 0;
        while (pos + fenceLen < text.length && text[pos + fenceLen] === fenceChar) {
          fenceLen++;
        }
        if (fenceLen >= 3) {
          const lineEndRaw = text.indexOf("\n", pos + fenceLen);
          const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
          const info = text.slice(pos + fenceLen, lineEnd);
          if (fenceChar !== "`" || !info.includes("`")) {
            let scan = lineEndRaw === -1 ? text.length : lineEndRaw + 1;
            let fenceEnd = text.length;
            while (scan < text.length) {
              const nextNewline = text.indexOf("\n", scan);
              const currLineEnd = nextNewline === -1 ? text.length : nextNewline;
              let closeSpaces = 0;
              let closePos = scan;
              while (closeSpaces < 3 && closePos < currLineEnd && text[closePos] === " ") {
                closeSpaces++;
                closePos++;
              }
              let closeLen = 0;
              while (closePos + closeLen < currLineEnd && text[closePos + closeLen] === fenceChar) {
                closeLen++;
              }
              if (closeLen >= fenceLen) {
                let onlyTrailingWhitespace = true;
                for (let tail = closePos + closeLen; tail < currLineEnd; tail++) {
                  const ch = text[tail];
                  if (ch !== " " && ch !== "\t" && ch !== "\r") {
                    onlyTrailingWhitespace = false;
                    break;
                  }
                }
                if (onlyTrailingWhitespace) {
                  fenceEnd = nextNewline === -1 ? text.length : nextNewline + 1;
                  break;
                }
              }
              scan = nextNewline === -1 ? text.length : nextNewline + 1;
            }
            ranges.push({ start: index, end: fenceEnd });
            index = fenceEnd;
            atLineStart = true;
            continue;
          }
        }
      }
    }

    if (text[index] === "`" && !isEscapedByBackslash(text, index)) {
      let tickLen = 0;
      while (index + tickLen < text.length && text[index + tickLen] === "`") {
        tickLen++;
      }
      let scan = index + tickLen;
      let closedEnd: number | undefined;
      while (scan < text.length) {
        if (text[scan] === "\n") {
          let lookahead = scan + 1;
          while (
            lookahead < text.length &&
            (text[lookahead] === " " || text[lookahead] === "\t" || text[lookahead] === "\r")
          ) {
            lookahead++;
          }
          if (text[lookahead] === "\n") break;
        }
        if (text[scan] === "`") {
          let closeLen = 0;
          while (scan + closeLen < text.length && text[scan + closeLen] === "`") {
            closeLen++;
          }
          if (closeLen === tickLen) {
            closedEnd = scan + closeLen;
            break;
          }
          scan += closeLen;
          continue;
        }
        scan++;
      }
      if (closedEnd !== undefined) {
        ranges.push({ start: index, end: closedEnd });
        index = closedEnd;
        atLineStart = false;
        continue;
      }
      index += tickLen;
      atLineStart = false;
      continue;
    }

    atLineStart = text[index] === "\n";
    index++;
  }

  return ranges;
}

export function overlapsCodeRange(
  start: number,
  end: number,
  ranges: readonly CodeRange[],
): boolean {
  for (const range of ranges) {
    if (range.start >= end) return false;
    if (range.end > start) return true;
  }
  return false;
}

export function filterAutocompleteSkills(
  skills: readonly SkillEntry[],
  query: string,
): SkillEntry[] {
  const enabled = skills.filter((skill) => skill.effectiveMode !== "disabled");
  const q = query.trim().toLowerCase();
  if (q === "") return enabled;

  const scored: { readonly skill: SkillEntry; readonly rank: number; readonly index: number }[] =
    [];
  for (let index = 0; index < enabled.length; index++) {
    const skill = enabled[index];
    if (!skill) continue;
    const nameLower = skill.name.toLowerCase();
    const descLower = skill.description.toLowerCase();
    let rank: number | undefined;
    if (nameLower.startsWith(q)) rank = 0;
    else if (nameLower.includes(q)) rank = 1;
    else if (descLower.includes(q)) rank = 2;
    if (rank !== undefined) {
      scored.push({ skill, rank, index });
    }
  }

  scored.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return scored.map((item) => item.skill);
}
