export type NormalizeCommandResult = {
  readonly command: string;
  readonly rewrittenNul: boolean;
};

type PendingHeredoc = {
  readonly delimiter: string;
  readonly stripTabs: boolean;
};

const NUL_DELIMITER = /^[\s;|&)#]$/;

function isCommentBoundary(prev: string | undefined): boolean {
  return (
    prev === undefined ||
    prev === " " ||
    prev === "\t" ||
    prev === "\n" ||
    prev === "\r" ||
    prev === ";" ||
    prev === "&" ||
    prev === "|" ||
    prev === "(" ||
    prev === ")"
  );
}

function isHeredocDelimiterStop(ch: string): boolean {
  return (
    ch === " " ||
    ch === "\t" ||
    ch === "\n" ||
    ch === "\r" ||
    ch === ";" ||
    ch === "&" ||
    ch === "|" ||
    ch === "(" ||
    ch === ")" ||
    ch === "<" ||
    ch === ">"
  );
}

export function normalizePosixBashCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): NormalizeCommandResult {
  if (platform !== "win32" || !/nul/i.test(command)) {
    return { command, rewrittenNul: false };
  }

  const n = command.length;
  let i = 0;
  let out = "";
  let rewrittenNul = false;
  const pendingHeredocs: PendingHeredoc[] = [];

  const consumePendingHeredocs = (): void => {
    while (pendingHeredocs.length > 0 && i < n) {
      const doc = pendingHeredocs.shift();
      if (doc === undefined) break;
      while (i < n) {
        const lineStart = i;
        let lineEnd = command.indexOf("\n", lineStart);
        if (lineEnd === -1) lineEnd = n;
        let rawLine = command.slice(lineStart, lineEnd);
        if (rawLine.endsWith("\r")) rawLine = rawLine.slice(0, -1);
        const candidate = doc.stripTabs ? rawLine.replace(/^\t+/, "") : rawLine;
        i = lineEnd < n ? lineEnd + 1 : n;
        out += command.slice(lineStart, i);
        if (candidate === doc.delimiter) break;
      }
    }
  };

  const parseHeredocDelimiter = (stripTabs: boolean): void => {
    while (i < n && (command[i] === " " || command[i] === "\t")) {
      out += command[i];
      i += 1;
    }
    let delimiter = "";
    let sawToken = false;
    while (i < n) {
      const ch = command[i] ?? "";
      if (ch === "'") {
        sawToken = true;
        out += "'";
        i += 1;
        while (i < n && command[i] !== "'") {
          const c = command[i] ?? "";
          out += c;
          delimiter += c;
          i += 1;
        }
        if (i < n && command[i] === "'") {
          out += "'";
          i += 1;
        }
        continue;
      }
      if (ch === '"') {
        sawToken = true;
        out += '"';
        i += 1;
        while (i < n && command[i] !== '"') {
          const c = command[i] ?? "";
          if (c === "\\" && i + 1 < n) {
            const next = command[i + 1] ?? "";
            out += c + next;
            if (next !== "\n") delimiter += next;
            i += 2;
            continue;
          }
          out += c;
          delimiter += c;
          i += 1;
        }
        if (i < n && command[i] === '"') {
          out += '"';
          i += 1;
        }
        continue;
      }
      if (ch === "\\") {
        sawToken = true;
        if (i + 1 < n) {
          const next = command[i + 1] ?? "";
          out += ch + next;
          if (next !== "\n") delimiter += next;
          i += 2;
        } else {
          out += ch;
          i += 1;
        }
        continue;
      }
      if (isHeredocDelimiterStop(ch)) break;
      sawToken = true;
      out += ch;
      delimiter += ch;
      i += 1;
    }
    if (sawToken) {
      pendingHeredocs.push({ delimiter, stripTabs });
    }
  };

  const tryRewriteNulTarget = (): void => {
    let wsEnd = i;
    while (wsEnd < n && (command[wsEnd] === " " || command[wsEnd] === "\t")) {
      wsEnd += 1;
    }
    if (wsEnd + 3 > n) return;
    if (command.slice(wsEnd, wsEnd + 3).toLowerCase() !== "nul") return;
    const after = command[wsEnd + 3];
    if (after !== undefined && !NUL_DELIMITER.test(after)) return;
    out += command.slice(i, wsEnd);
    out += "/dev/null";
    i = wsEnd + 3;
    rewrittenNul = true;
  };

  const scanSingleQuoted = (): void => {
    out += "'";
    i += 1;
    const close = command.indexOf("'", i);
    if (close === -1) {
      out += command.slice(i);
      i = n;
      return;
    }
    out += command.slice(i, close + 1);
    i = close + 1;
  };

  const scanAnsiCQuoted = (): void => {
    out += "$'";
    i += 2;
    while (i < n) {
      const ch = command[i] ?? "";
      if (ch === "\\" && i + 1 < n) {
        out += ch + (command[i + 1] ?? "");
        i += 2;
        continue;
      }
      out += ch;
      i += 1;
      if (ch === "'") return;
    }
  };

  const scanDoubleQuoted = (): void => {
    out += '"';
    i += 1;
    while (i < n) {
      const ch = command[i] ?? "";
      if (ch === "\\" && i + 1 < n) {
        out += ch + (command[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (ch === '"') {
        out += '"';
        i += 1;
        return;
      }
      if (ch === "$" && command[i + 1] === "(" && command[i + 2] !== "(") {
        out += "$(";
        i += 2;
        scanCommand(true);
        if (i < n && command[i] === ")") {
          out += ")";
          i += 1;
        }
        continue;
      }
      out += ch;
      i += 1;
    }
  };

  const scanCommand = (stopOnParen: boolean): void => {
    let parenDepth = 0;
    while (i < n) {
      const ch = command[i] ?? "";
      if (stopOnParen && ch === ")" && parenDepth === 0) return;

      if (ch === "'") {
        scanSingleQuoted();
        continue;
      }
      if (ch === "$" && command[i + 1] === "'") {
        scanAnsiCQuoted();
        continue;
      }
      if (ch === '"') {
        scanDoubleQuoted();
        continue;
      }
      if (ch === "\\") {
        if (i + 1 < n) {
          out += ch + (command[i + 1] ?? "");
          i += 2;
        } else {
          out += ch;
          i += 1;
        }
        continue;
      }
      if (ch === "#" && isCommentBoundary(command[i - 1])) {
        const nl = command.indexOf("\n", i);
        if (nl === -1) {
          out += command.slice(i);
          i = n;
          return;
        }
        out += command.slice(i, nl);
        i = nl;
        continue;
      }
      if (ch === "\n") {
        out += "\n";
        i += 1;
        if (pendingHeredocs.length > 0) consumePendingHeredocs();
        continue;
      }
      if (ch === "(") {
        parenDepth += 1;
        out += "(";
        i += 1;
        continue;
      }
      if (ch === ")") {
        if (parenDepth > 0) parenDepth -= 1;
        out += ")";
        i += 1;
        continue;
      }
      if (ch === "&") {
        if (command[i + 1] === "&") {
          out += "&&";
          i += 2;
        } else if (command[i + 1] === ">" && command[i + 2] === ">") {
          out += "&>>";
          i += 3;
          tryRewriteNulTarget();
        } else if (command[i + 1] === ">") {
          out += "&>";
          i += 2;
          tryRewriteNulTarget();
        } else {
          out += "&";
          i += 1;
        }
        continue;
      }
      if (ch === "<") {
        if (command[i + 1] === "<" && command[i + 2] === "<") {
          out += "<<<";
          i += 3;
        } else if (command[i + 1] === "<" && command[i + 2] === "-") {
          out += "<<-";
          i += 3;
          parseHeredocDelimiter(true);
        } else if (command[i + 1] === "<") {
          out += "<<";
          i += 2;
          parseHeredocDelimiter(false);
        } else if (command[i + 1] === "(") {
          out += "<(";
          i += 2;
          parenDepth += 1;
        } else if (command[i + 1] === "&") {
          out += "<&";
          i += 2;
        } else if (command[i + 1] === ">") {
          out += "<>";
          i += 2;
          tryRewriteNulTarget();
        } else {
          out += "<";
          i += 1;
          tryRewriteNulTarget();
        }
        continue;
      }
      if (ch === ">") {
        if (command[i + 1] === "(") {
          out += ">(";
          i += 2;
          parenDepth += 1;
        } else if (command[i + 1] === ">") {
          out += ">>";
          i += 2;
          tryRewriteNulTarget();
        } else if (command[i + 1] === "|") {
          out += ">|";
          i += 2;
          tryRewriteNulTarget();
        } else if (command[i + 1] === "&") {
          const prev = command[i - 1];
          const precededByDigit = prev !== undefined && prev >= "0" && prev <= "9";
          out += ">&";
          i += 2;
          if (!precededByDigit) tryRewriteNulTarget();
        } else {
          out += ">";
          i += 1;
          tryRewriteNulTarget();
        }
        continue;
      }
      out += ch;
      i += 1;
    }
  };

  scanCommand(false);
  return rewrittenNul ? { command: out, rewrittenNul: true } : { command, rewrittenNul: false };
}
