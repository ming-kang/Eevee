import {
  type PutSkillsPolicyRequest,
  type SkillsListResponse,
  SkillsListResponseSchema,
} from "../schemas/skills.ts";
import type { HttpTransport } from "./transport.ts";

export class ScopedSkillsClient {
  readonly #transport: HttpTransport;
  readonly #prefix: string;

  constructor(transport: HttpTransport, projectId?: string) {
    this.#transport = transport;
    this.#prefix =
      projectId === undefined ? "/skills" : `/projects/${encodeURIComponent(projectId)}/skills`;
  }

  list(signal?: AbortSignal): Promise<SkillsListResponse> {
    return this.#transport.get(this.#prefix, SkillsListResponseSchema, signal);
  }

  putPolicy(input: PutSkillsPolicyRequest, signal?: AbortSignal): Promise<SkillsListResponse> {
    return this.#transport.put(`${this.#prefix}/policy`, SkillsListResponseSchema, input, signal);
  }
}
