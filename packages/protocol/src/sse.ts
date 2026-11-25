export type SseEvent = {
  readonly event: string;
  readonly data: string;
  readonly id?: string;
};

export async function* parseSseStream(
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  if (body === null || signal?.aborted) return;

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");

  let abortResolve: (() => void) | undefined;
  const abortPromise =
    signal === undefined
      ? undefined
      : new Promise<void>((resolve) => {
          abortResolve = resolve;
        });

  const onAbort = () => {
    abortResolve?.();
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  let isFirstChunk = true;
  let ignoreLeadingLf = false;
  let lineBuffer = "";
  let eventName = "";
  let dataLines: string[] = [];
  let lastEventId: string | undefined;

  const processLine = (line: string): SseEvent | undefined => {
    if (line === "") {
      if (dataLines.length === 0) {
        eventName = "";
        return undefined;
      }
      const event: SseEvent = {
        event: eventName || "message",
        data: dataLines.join("\n"),
        ...(lastEventId === undefined ? {} : { id: lastEventId }),
      };
      eventName = "";
      dataLines = [];
      return event;
    }

    if (line.startsWith(":")) return undefined;

    const colonIndex = line.indexOf(":");
    let field: string;
    let value: string;
    if (colonIndex === -1) {
      field = line;
      value = "";
    } else {
      field = line.slice(0, colonIndex);
      value = line.slice(colonIndex + 1);
      if (value.startsWith(" ")) value = value.slice(1);
    }

    if (field === "event") {
      eventName = value;
    } else if (field === "data") {
      dataLines.push(value);
    } else if (field === "id") {
      if (!value.includes("\u0000")) lastEventId = value;
    }
    return undefined;
  };

  const scanText = (raw: string): SseEvent[] => {
    let text = raw;
    if (isFirstChunk) {
      isFirstChunk = false;
      if (text.startsWith("\uFEFF")) text = text.slice(1);
    }
    if (ignoreLeadingLf) {
      ignoreLeadingLf = false;
      if (text.startsWith("\n")) text = text.slice(1);
    }

    const events: SseEvent[] = [];
    let start = 0;
    for (let index = 0; index < text.length; index++) {
      const ch = text[index];
      if (ch === "\n") {
        const line = lineBuffer + text.slice(start, index);
        lineBuffer = "";
        const emitted = processLine(line);
        if (emitted !== undefined) events.push(emitted);
        start = index + 1;
      } else if (ch === "\r") {
        const line = lineBuffer + text.slice(start, index);
        lineBuffer = "";
        const emitted = processLine(line);
        if (emitted !== undefined) events.push(emitted);
        if (index + 1 < text.length) {
          if (text[index + 1] === "\n") index += 1;
        } else {
          ignoreLeadingLf = true;
        }
        start = index + 1;
      }
    }
    lineBuffer += text.slice(start);
    return events;
  };

  try {
    while (!signal?.aborted) {
      const result =
        abortPromise === undefined
          ? await reader.read()
          : await Promise.race([
              reader.read(),
              abortPromise.then(() => ({ done: true, value: undefined }) as const),
            ]);

      if (signal?.aborted) break;

      if (result.done) {
        const trailing = decoder.decode();
        if (trailing.length > 0) {
          for (const event of scanText(trailing)) yield event;
        }
        break;
      }

      if (result.value !== undefined) {
        const text = decoder.decode(result.value, { stream: true });
        for (const event of scanText(text)) yield event;
      }
    }
  } catch (error) {
    if (!signal?.aborted) throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // Lock may already be released by stream termination.
    }
  }
}
