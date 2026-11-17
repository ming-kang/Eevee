export const TEXT_PAGE = { default: 4000, max: 8000 } as const;
export const LIST_PAGE = { default: 20, max: 50 } as const;

export type Page = {
  text: string;
  nextOffset?: number;
  total: number;
};

export function pageText(text: string, offset = 0, limit: number = TEXT_PAGE.default): Page {
  const size = Math.min(Math.max(1, limit), TEXT_PAGE.max);
  const start = Math.min(Math.max(0, offset), text.length);
  const end = Math.min(start + size, text.length);
  return {
    text: text.slice(start, end),
    total: text.length,
    ...(end < text.length ? { nextOffset: end } : {}),
  };
}

export function pageList<T>(items: readonly T[], offset = 0, limit: number = LIST_PAGE.default) {
  const size = Math.min(Math.max(1, limit), LIST_PAGE.max);
  const start = Math.min(Math.max(0, offset), items.length);
  const end = Math.min(start + size, items.length);
  return {
    items: items.slice(start, end),
    total: items.length,
    ...(end < items.length ? { nextOffset: end } : {}),
  };
}

export function continuation(
  address: string,
  page: { nextOffset?: number; total: number },
): string {
  return page.nextOffset === undefined
    ? ""
    : `\n\n[还有内容：共 ${page.total}，用 read("${address}", offset: ${page.nextOffset}) 继续]`;
}
