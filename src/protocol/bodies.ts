/**
 * What each HTTP route's request body has to look like, as a schema the boundary checks before a handler sees
 * it. The route table in `contract.ts` derives its body types from these, so a client, the Engine and the panel
 * share one definition; `http.ts` compiles them all and refuses a body that does not fit.
 *
 * A field the client may leave out is `opt()`; a blank string is not a missing one, so a field that must carry
 * something is a plain `str()` and its handler still reports `required` for a blank value. A provider or MCP
 * entry is checked as an object here and in full by the Engine, which owns its meaning.
 */
import {
  arr,
  int,
  map,
  nullable,
  obj,
  oneOf,
  opt,
  type Properties,
  type Schema,
  type StaticObject,
  str,
  unsafe,
} from "@earendil-works/pi-schema";
import { ROLE_NAMES, THINKING_LEVELS } from "../domain/index.ts";
import type { ProviderConfigView, RouteBody, RouteKey } from "./contract.ts";

/** A request body: the fields it declares are checked, and any others are ignored, as they always were. */
const body = <P extends Properties>(properties: P): Schema<StaticObject<P>> =>
  obj(properties, { open: true });

const modelFields = {
  provider: str(),
  modelId: str(),
  thinkingLevel: opt(oneOf(THINKING_LEVELS)),
};

/** A role a model setting names: one of the roles, or `default` for the settings' own. */
const roleField = opt(oneOf([...ROLE_NAMES, "default"] as const));

const schemas = {
  "POST /api/session": body({ code: str() }),
  "POST /api/settings/models": body({ role: roleField, ...modelFields }),
  "POST /api/auth/:provider": body({ key: str() }),
  "PUT /api/models/providers/:provider": body({
    // The Engine checks the entry against the models.json schema before writing it.
    config: unsafe<ProviderConfigView>({ type: "object" }),
  }),
  "POST /api/models/builtin": body({ query: str(), api: opt(str()) }),
  "POST /api/models/probe": body({
    provider: opt(str()),
    baseUrl: str(),
    api: opt(str()),
    key: opt(str()),
    headers: opt(map(str())),
  }),
  "POST /api/capabilities/roles/:role": body({
    extensions: opt(arr(str())),
    maxTurns: opt(nullable(int({ minimum: 1 }))),
  }),
  "PUT /api/mcp/servers/:server": body({
    // The MCP hub checks the entry against mcp.json's schema before writing it.
    config: unsafe<Record<string, unknown>>({ type: "object" }),
  }),
  "POST /api/projects": body({ title: str(), workspace: str() }),
  "POST /api/projects/:project/models": body({
    role: roleField,
    /** `null` drops the project's own choice, so the role follows the settings again. */
    model: nullable(body(modelFields)),
  }),
  "POST /api/projects/:project/messages": body({ text: str() }),
  "POST /api/projects/:project/tickets/:ticket/messages": body({
    text: str(),
    mode: opt(oneOf(["steer", "followUp"] as const)),
  }),
  "POST /api/projects/:project/questions/:question/answer": body({
    answer: str(),
    answers: opt(arr(str())),
  }),
};

/**
 * Every route with a body has a schema, keyed as in the route table: a route whose body the table declares but
 * `schemas` does not hold is a missing key here, which is a compile error. `http.ts` compiles these.
 */
export const ROUTE_BODIES: { [K in BodyRouteKey]: (typeof schemas)[K] } = schemas;

export type BodyRouteKey = {
  [K in RouteKey]: RouteBody<K> extends undefined ? never : K;
}[RouteKey];

export type BodySchema<K extends BodyRouteKey> = (typeof schemas)[K];
