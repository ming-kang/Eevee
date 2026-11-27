import {
  type PutSkillsPolicyRequest,
  type SkillsListResponse,
  SkillsListResponseSchema,
} from "../schemas/skills.ts";
import type { HttpTransport } from "./transport.ts";

export function createScopedSkillsClient(transport: HttpTransport, projectId?: string) {
  const prefix =
    projectId === undefined ? "/skills" : `/projects/${encodeURIComponent(projectId)}/skills`;
  return {
    list(signal?: AbortSignal): Promise<SkillsListResponse> {
      return transport.get(prefix, SkillsListResponseSchema, signal);
    },

    putPolicy(input: PutSkillsPolicyRequest, signal?: AbortSignal): Promise<SkillsListResponse> {
      return transport.put(`${prefix}/policy`, SkillsListResponseSchema, input, signal);
    },
  };
}

export type ScopedSkillsClient = ReturnType<typeof createScopedSkillsClient>;
