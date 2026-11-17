import {
  type ApiError,
  type RouteBody,
  type RouteKey,
  type RouteParams,
  type RouteResponse,
  TOKEN_HEADER,
} from "./contract.ts";

export class ApiRequestError extends Error {
  override name = "ApiRequestError";
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
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
      if (value === undefined) throw new Error(`缺少路径参数 ${name}`);
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
    const payload = response.status === 204 ? undefined : await response.json();
    if (!response.ok) {
      const error = (payload as ApiError | undefined)?.error;
      throw new ApiRequestError(
        response.status,
        error?.code ?? "http",
        error?.message ?? response.statusText,
      );
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
