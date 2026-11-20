/** How the panel shows a ticket or job id: `t4` reads as `T4`, `j2` as `J2`. Ids stay lowercase everywhere else. */
export function displayId(id: string): string {
  return /^[tj]\d/.test(id) ? id[0]?.toUpperCase() + id.slice(1) : id;
}
