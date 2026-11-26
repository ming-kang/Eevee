export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function stripJsonTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next] ?? "")) next++;
      if (text[next] === "}" || text[next] === "]") continue;
    }
    out += ch;
  }
  return out;
}

export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  let index = 0;

  while (index < text.length) {
    const ch = text.charAt(index);
    const next = text.charAt(index + 1);

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      index++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      index++;
      continue;
    }

    if (ch === "/" && next === "/") {
      index += 2;
      while (index < text.length && text[index] !== "\n" && text[index] !== "\r") {
        index++;
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        if (text[index] === "\n") out += "\n";
        index++;
      }
      if (index < text.length) index += 2;
      continue;
    }

    out += ch;
    index++;
  }

  return out;
}
