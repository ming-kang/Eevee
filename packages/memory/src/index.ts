export const MEMORY_EXTENSION = "eevee.memory";

export const MEMORY_TOOLS = {
  zoom: "zoom",
  search: "search",
} as const;

export type ForestNodeRef = {
  readonly level: number;
  readonly index: number;
};
