export type Params = Record<string, string | number>;
export type Translate = (key: string, params?: Params) => string;

/** `text` with each `{name}` replaced by its parameter; a parameter the text does not use is left alone. */
export function fill(text: string, params?: Params): string {
  if (params === undefined) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}
