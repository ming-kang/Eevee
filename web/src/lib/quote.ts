/**
 * A selection quoted for the composer: CRLF folded to LF, trailing blank lines dropped, every
 * line under `> ` (empty ones just `>`), and a blank line after the block for the reply.
 */
export function quoteMarkdown(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && (lines.at(-1) ?? "").trim() === "") lines.pop();
  const quoted = lines.map((line) => (line.trim() === "" ? ">" : `> ${line}`)).join("\n");
  return `${quoted}\n\n`;
}
