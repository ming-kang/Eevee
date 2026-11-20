import type { Problem } from "../domain/index.ts";
import {
  type ApiError,
  type ProblemBody,
  type RouteBody,
  type RouteKey,
  type RouteParams,
  type RouteResponse,
  TOKEN_HEADER,
} from "./contract.ts";

/** A refused request: the Problem to word, and the Engine's own wording as the message. */
export class ApiRequestError extends Error {
  override name = "ApiRequestError";
  readonly status: number;
  readonly problem: Problem;

  constructor(status: number, { message, ...problem }: ProblemBody) {
    super(message);
    this.status = status;
    this.problem = problem as Problem;
  }
}

export type ClientOptions = {
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
};

export function createClient(options: ClientOptions) {
  const doFetch = options.fetch ?? fetch;

  async function call<K extends RouteKey>(
    route: K,
    ...rest: CallArgs<K>
  ): Promise<RouteResponse<K>> {
    const [params, body] = splitArgs(route, rest);
    const [method, template] = route.split(" ") as [string, string];
    const path = template.replace(/:([a-z]+)/g, (_, name: string) => {
      const value = (params as Record<string, string>)[name];
      if (value === undefined)
        throw new Error(`The request is missing the ${name} path parameter.`);
      return encodeURIComponent(value);
    });
    const response = await doFetch(new URL(path, options.baseUrl), {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(options.token === undefined ? {} : { [TOKEN_HEADER]: options.token }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload =
      response.status === 204 ? undefined : await response.json().catch(() => undefined);
    if (!response.ok) {
      const detail = response.statusText || String(response.status);
      const error = (payload as ApiError | undefined)?.error ?? {
        code: "internal",
        detail,
        message: detail,
      };
      throw new ApiRequestError(response.status, error);
    }
    return payload as RouteResponse<K>;
  }

  return { call };
}

export type Client = ReturnType<typeof createClient>;

type HasParams<K extends RouteKey> = keyof RouteParams<K> extends never ? false : true;
type HasBody<K extends RouteKey> = RouteBody<K> extends undefined ? false : true;

type CallArgs<K extends RouteKey> =
  HasParams<K> extends true
    ? HasBody<K> extends true
      ? [params: RouteParams<K>, body: RouteBody<K>]
      : [params: RouteParams<K>]
    : HasBody<K> extends true
      ? [body: RouteBody<K>]
      : [];

function splitArgs(route: string, rest: readonly unknown[]): [unknown, unknown] {
  return route.includes(":") ? [rest[0], rest[1]] : [{}, rest[0]];
}
