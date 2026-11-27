import ignore, { type Ignore } from "ignore";

export type IgnoreRule = {
  readonly base: string;
  readonly matcher: Ignore;
};

export function createIgnoreRule(base: string, patterns: string): IgnoreRule {
  return { base, matcher: ignore().add(patterns) };
}

export function isIgnoredByRules(
  rules: readonly IgnoreRule[],
  relativePath: string,
  directory: boolean,
): boolean {
  for (let index = rules.length - 1; index >= 0; index--) {
    const rule = rules[index];
    if (rule === undefined) continue;
    let relative: string;
    if (rule.base === "") {
      relative = relativePath;
    } else if (relativePath.startsWith(`${rule.base}/`)) {
      relative = relativePath.slice(rule.base.length + 1);
    } else {
      continue;
    }
    if (relative === "") continue;
    const result = rule.matcher.test(directory ? `${relative}/` : relative);
    if (result.ignored) return true;
    if (result.unignored) return false;
  }
  return false;
}
