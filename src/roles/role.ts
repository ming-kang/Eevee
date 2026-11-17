import {
  type AgentChange,
  type ConversationId,
  configure,
  type RegistrySnapshot,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import type { RoleName } from "../contracts/index.ts";

export type MemorySnapshot = {
  global: string;
  project: string;
};

export type Role<Subject> = {
  name: RoleName;
  instructions: string;
  tools: readonly string[];
  opening(subject: Subject, memory: MemorySnapshot): string;
};

export const defineRole = <Subject>(role: Role<Subject>): Role<Subject> => role;

export function resolveTools(
  registry: RegistrySnapshot,
  names: readonly string[],
): ToolRegistration[] {
  const available = new Map(registry.tools().map(({ tool }) => [tool.name, tool]));
  return names.map((name) => {
    const tool = available.get(name);
    if (tool === undefined) throw new Error(`角色需要的工具 ${name} 没有安装`);
    return tool;
  });
}

export async function applyRole(
  tx: Tx,
  conversationId: ConversationId,
  role: Role<never>,
  registry: RegistrySnapshot,
  change: Omit<AgentChange, "tools" | "instructions"> = {},
): Promise<void> {
  await configure(tx, conversationId, {
    ...change,
    tools: resolveTools(registry, role.tools),
    instructions: role.instructions,
  });
}
