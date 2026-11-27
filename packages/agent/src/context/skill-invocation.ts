import { readFile } from "node:fs/promises";
import { errorMessage } from "../shared/guards.ts";
import { escapeXmlAttr } from "../shared/xml.ts";
import {
  resolveSkillTriggerMode,
  type SkillInfo,
  type SkillPolicyMap,
  type SkillTriggerMode,
  stripSkillFrontmatter,
} from "./discovery.ts";

export type InvokedSkill = {
  readonly name: string;
  readonly path: string;
  readonly mode: SkillTriggerMode;
};

export type ExpandSkillsResult = {
  readonly text: string;
  readonly invoked: readonly InvokedSkill[];
  readonly blocked: readonly { readonly name: string; readonly reason: string }[];
  readonly errors: readonly {
    readonly name: string;
    readonly path: string;
    readonly message: string;
  }[];
};

export type SkillInvocationResult = ExpandSkillsResult;

type CodeRange = {
  readonly start: number;
  readonly end: number;
};

type SkillMatch = {
  readonly skill: SkillInfo;
  readonly start: number;
  readonly end: number;
};

const SKILL_PREFIX = "/skill:";
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const IDENT_OR_PATH_LEFT_RE = /[\p{L}\p{N}_./\\-]/u;
const IDENT_RIGHT_RE = /[\p{L}\p{N}_-]/u;

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
          // CommonMark: backtick fence info strings cannot contain backticks (those are inline spans).
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

function findCodeRangeAt(offset: number, ranges: readonly CodeRange[]): CodeRange | undefined {
  for (const range of ranges) {
    if (offset < range.start) return undefined;
    if (offset < range.end) return range;
  }
  return undefined;
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

function isValidRightBoundary(text: string, endIndex: number): boolean {
  if (endIndex >= text.length) return true;
  const next = text[endIndex];
  if (next === undefined) return true;
  if (CJK_RE.test(next)) return true;
  if (next === "/" || next === "\\") return false;
  if (next === ".") {
    const afterDot = text[endIndex + 1];
    if (afterDot !== undefined && !CJK_RE.test(afterDot) && IDENT_RIGHT_RE.test(afterDot)) {
      return false;
    }
    return true;
  }
  return !IDENT_RIGHT_RE.test(next);
}

function findSkillMatches(
  text: string,
  skills: readonly SkillInfo[],
  codeRanges: readonly CodeRange[],
): SkillMatch[] {
  const seenNames = new Set<string>();
  const candidates: SkillInfo[] = [];
  for (const skill of skills) {
    if (skill.name === "" || seenNames.has(skill.name)) continue;
    seenNames.add(skill.name);
    candidates.push(skill);
  }
  candidates.sort((left, right) => right.name.length - left.name.length);
  if (candidates.length === 0) return [];

  const matches: SkillMatch[] = [];
  let pos = 0;

  while (pos < text.length) {
    const inside = findCodeRangeAt(pos, codeRanges);
    if (inside !== undefined) {
      pos = inside.end;
      continue;
    }
    const foundIndex = text.indexOf(SKILL_PREFIX, pos);
    if (foundIndex < 0) break;

    const codeAtPrefix = findCodeRangeAt(foundIndex, codeRanges);
    if (codeAtPrefix !== undefined) {
      pos = codeAtPrefix.end;
      continue;
    }

    if (!isValidLeftBoundary(text, foundIndex)) {
      pos = foundIndex + SKILL_PREFIX.length;
      continue;
    }

    const nameStart = foundIndex + SKILL_PREFIX.length;
    let matched: SkillMatch | undefined;
    for (const candidate of candidates) {
      if (!text.startsWith(candidate.name, nameStart)) continue;
      const end = nameStart + candidate.name.length;
      if (overlapsCodeRange(foundIndex, end, codeRanges)) continue;
      if (!isValidRightBoundary(text, end)) continue;
      matched = { skill: candidate, start: foundIndex, end };
      break;
    }

    if (matched !== undefined) {
      matches.push(matched);
      pos = matched.end;
    } else {
      pos = nameStart;
    }
  }

  return matches;
}

function isWhitespaceOnly(text: string): boolean {
  return /^\s*$/.test(text);
}

export async function expandSkillReferences(
  text: string,
  skills: readonly SkillInfo[],
  options?: { readonly policy?: SkillPolicyMap },
): Promise<ExpandSkillsResult> {
  if (skills.length === 0 || !text.includes(SKILL_PREFIX)) {
    return { text, invoked: [], blocked: [], errors: [] };
  }

  const codeRanges = findCodeRanges(text);
  const matches = findSkillMatches(text, skills, codeRanges);
  if (matches.length === 0) {
    return { text, invoked: [], blocked: [], errors: [] };
  }

  const blocks: string[] = [];
  const invoked: InvokedSkill[] = [];
  const blocked: { readonly name: string; readonly reason: string }[] = [];
  const errors: { readonly name: string; readonly path: string; readonly message: string }[] = [];

  const outcomeByName = new Map<string, "expanded" | "blocked" | "error">();
  let sawUnexpanded = false;
  let sawExpandedAfterUnexpanded = false;
  let lastLeadingExpandedEnd: number | undefined;

  for (const match of matches) {
    const { skill } = match;
    const cached = outcomeByName.get(skill.name);
    if (cached !== undefined) {
      if (cached === "expanded") {
        if (sawUnexpanded) sawExpandedAfterUnexpanded = true;
        else lastLeadingExpandedEnd = match.end;
      } else {
        sawUnexpanded = true;
      }
      continue;
    }

    const mode = resolveSkillTriggerMode(skill, options?.policy);
    if (mode === "disabled") {
      outcomeByName.set(skill.name, "blocked");
      blocked.push({ name: skill.name, reason: `Skill "${skill.name}" is disabled` });
      sawUnexpanded = true;
      continue;
    }

    try {
      const raw = await readFile(skill.path, "utf8");
      const body = stripSkillFrontmatter(raw).trim();
      const header = `<skill name="${escapeXmlAttr(skill.name)}" location="${escapeXmlAttr(skill.path)}">\nReferences are relative to ${skill.baseDir}.`;
      const block = body === "" ? `${header}\n</skill>` : `${header}\n\n${body}\n</skill>`;
      blocks.push(block);
      invoked.push({ name: skill.name, path: skill.path, mode });
      outcomeByName.set(skill.name, "expanded");
      if (sawUnexpanded) sawExpandedAfterUnexpanded = true;
      else lastLeadingExpandedEnd = match.end;
    } catch (error) {
      outcomeByName.set(skill.name, "error");
      errors.push({
        name: skill.name,
        path: skill.path,
        message: errorMessage(error),
      });
      sawUnexpanded = true;
    }
  }

  if (blocks.length === 0) {
    return { text, invoked, blocked, errors };
  }

  const joinedBlocks = blocks.join("\n\n");

  let isLeadingPrefix = !sawExpandedAfterUnexpanded && lastLeadingExpandedEnd !== undefined;
  if (isLeadingPrefix) {
    const first = matches[0];
    if (first === undefined || !isWhitespaceOnly(text.slice(0, first.start))) {
      isLeadingPrefix = false;
    } else {
      for (let i = 1; i < matches.length; i++) {
        const prev = matches[i - 1];
        const curr = matches[i];
        if (prev === undefined || curr === undefined) {
          isLeadingPrefix = false;
          break;
        }
        if (!isWhitespaceOnly(text.slice(prev.end, curr.start))) {
          isLeadingPrefix = false;
          break;
        }
      }
    }
  }

  if (isLeadingPrefix && lastLeadingExpandedEnd !== undefined) {
    const tail = text.slice(lastLeadingExpandedEnd);
    const trimmedTail = tail.trim() === "" ? "" : tail.trimStart();
    const expandedText = trimmedTail === "" ? joinedBlocks : `${joinedBlocks}\n\n${trimmedTail}`;
    return { text: expandedText, invoked, blocked, errors };
  }

  return {
    text: `${joinedBlocks}\n\n${text}`,
    invoked,
    blocked,
    errors,
  };
}
