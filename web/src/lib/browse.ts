/** Helpers for the directory browser's path bar: breadcrumbs and the typed-path query. */

export type PathCrumb = { label: string; path: string };

/** The ancestors of an absolute path, each with the path it navigates to. */
export function pathCrumbs(path: string): PathCrumb[] {
  const sep = path.includes("\\") ? "\\" : "/";
  const unc = path.startsWith(`${sep}${sep}`);
  const parts = path.split(/[\\/]+/).filter((part) => part !== "");
  const crumbs: PathCrumb[] = [];
  for (const [index, part] of parts.entries()) {
    if (index === 0) {
      if (unc) crumbs.push({ label: `${sep}${sep}${part}`, path: `${sep}${sep}${part}` });
      else if (sep === "/") crumbs.push({ label: `/${part}`, path: `/${part}` });
      else crumbs.push({ label: `${part}${sep}`, path: `${part}${sep}` });
    } else {
      const base = crumbs[crumbs.length - 1]?.path ?? "";
      const prefix = base.endsWith(sep) ? base : `${base}${sep}`;
      crumbs.push({ label: part, path: `${prefix}${part}` });
    }
  }
  return crumbs;
}

/** A partially typed path, split into the directory to list and the name prefix to match. */
export function splitPathQuery(text: string): { dir: string; prefix: string } | undefined {
  const last = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  if (last < 0) return undefined;
  return { dir: text.slice(0, last + 1), prefix: text.slice(last + 1) };
}
