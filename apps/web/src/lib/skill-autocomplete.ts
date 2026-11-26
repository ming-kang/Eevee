import type { SkillEntry } from "@eevee/protocol";

export type SkillAutocompleteToken = {
  readonly query: string;
  readonly start: number;
  readonly end: number;
};

type CodeRange = {
  readonly start: number;
  readonly end: number;
};

const SKILL_COLON_PREFIX = "/skill:";
const SKILL_WORD_PREFIX = "/skill";
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const IDENT_OR_PATH_LEFT_RE = /[\p{L}\p{N}_./\\-]/u;
const AUTOCOMPLETE_STOP_RE = /[\s,.;:!?()[\]{}<>"'`/\\，。；：！？、（）【】「」『』《》“”‘’]/;

function isEscapedByBackslash(text: string, index: number): boolean {
  let count = 0;
  for (let pos = index - 1; pos >= 0 && text[pos] === "\\"; pos--) {
    count++;
  }
  return count % 2 === 1;
}

function findCodeRanges(text: string): CodeRange[] {
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

function overlapsCodeRange(start: number, end: number, ranges: readonly CodeRange[]): boolean {
  for (const range of ranges) {
    if (range.start >= end) return false;
    if (range.end > start) return true;
  }
  return false;
}

function isValidLeftBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const prev = text[index - 1];
  if (prev === undefined) return true;
  if (CJK_RE.test(prev)) return true;
  return !IDENT_OR_PATH_LEFT_RE.test(prev);
}

function isAutocompleteStopChar(ch: string): boolean {
  return AUTOCOMPLETE_STOP_RE.test(ch) || CJK_RE.test(ch);
}

function hasAutocompleteStopChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== undefined && isAutocompleteStopChar(ch)) return true;
  }
  return false;
}

function scanTokenEnd(text: string, cursor: number): number {
  let end = cursor;
  while (end < text.length) {
    const ch = text[end];
    if (ch === undefined || isAutocompleteStopChar(ch)) break;
    end++;
  }
  return end;
}

export function extractSkillAutocompleteToken(
  text: string,
  cursorOffset: number,
): SkillAutocompleteToken | undefined {
  const cursor = Math.max(0, Math.min(cursorOffset, text.length));
  const beforeCursor = text.slice(0, cursor);
  const codeRanges = findCodeRanges(text);

  const colonIndex = beforeCursor.lastIndexOf(SKILL_COLON_PREFIX);
  if (colonIndex >= 0 && isValidLeftBoundary(text, colonIndex)) {
    const queryStart = colonIndex + SKILL_COLON_PREFIX.length;
    const query = text.slice(queryStart, cursor);
    if (!hasAutocompleteStopChar(query)) {
      const end = scanTokenEnd(text, cursor);
      if (!overlapsCodeRange(colonIndex, Math.max(end, queryStart), codeRanges)) {
        return { query, start: colonIndex, end };
      }
    }
  }

  const wordIndex = beforeCursor.lastIndexOf(SKILL_WORD_PREFIX);
  if (wordIndex >= 0 && isValidLeftBoundary(text, wordIndex)) {
    const afterPrefixIndex = wordIndex + SKILL_WORD_PREFIX.length;
    if (text[afterPrefixIndex] !== ":") {
      const afterPrefix = text.slice(afterPrefixIndex, cursor);
      if (afterPrefix === "") {
        const nextChar = text[cursor];
        if (nextChar === undefined || isAutocompleteStopChar(nextChar)) {
          if (!overlapsCodeRange(wordIndex, afterPrefixIndex, codeRanges)) {
            return { query: "", start: wordIndex, end: cursor };
          }
        }
      } else {
        const spaceMatch = /^[ \t]+(.*)$/.exec(afterPrefix);
        if (spaceMatch) {
          const query = spaceMatch[1] ?? "";
          if (!hasAutocompleteStopChar(query)) {
            const end = scanTokenEnd(text, cursor);
            if (!overlapsCodeRange(wordIndex, Math.max(end, cursor), codeRanges)) {
              return { query, start: wordIndex, end };
            }
          }
        }
      }
    }
  }

  return undefined;
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

export function applySkillAutocomplete(
  text: string,
  token: SkillAutocompleteToken,
  skillName: string,
): { readonly nextText: string; readonly nextCursor: number } {
  const base = `${SKILL_COLON_PREFIX}${skillName}`;
  const hasTrailingSpace = text[token.end] === " ";
  const insertion = hasTrailingSpace ? base : `${base} `;
  const nextText = `${text.slice(0, token.start)}${insertion}${text.slice(token.end)}`;
  const nextCursor = token.start + base.length + 1;
  return { nextText, nextCursor };
}
