import type {
  ModelDefaults,
  Question,
  Report,
  RoleName,
  Ticket,
  TicketStage,
} from "../contracts/index.ts";

export type ProjectSummary = {
  id: string;
  title: string;
  workspace: string;
  createdAt: number;
  models?: ModelDefaults;
};

export type EngineStatus = {
  bootId: string;
  version: string;
  port: number;
  projects: ProjectSummary[];
};

export type TicketView = {
  ticket: Ticket;
  stage: TicketStage;
  reports: Report[];
};

export type BoardView = {
  tickets: TicketView[];
  openQuestions: Question[];
};

export type ChatLine = {
  id: number;
  role: "user" | "assistant" | "tool" | "notice" | "reset";
  text: string;
};

export type ConversationView = {
  lines: ChatLine[];
  running: boolean;
  failure?: string;
};

type Ok = { ok: true };

export type ApiRoutes = {
  "GET /api/health": { response: Ok };
  "GET /api/status": { response: EngineStatus };
  "POST /api/shutdown": { response: Ok };
  "POST /api/session": { body: { code: string }; response: { token: string } };
  "POST /api/session/code": { response: { code: string } };
  "GET /api/models": { response: { catalog: string } };
  "POST /api/settings/models": {
    body: { role?: RoleName | "default"; provider: string; modelId: string };
    response: Ok;
  };
  "POST /api/auth/:provider": { body: { key: string }; response: Ok };
  "POST /api/projects": { body: { title: string; workspace: string }; response: ProjectSummary };
  "GET /api/projects/:project/board": { response: BoardView };
  "GET /api/projects/:project/conversation": { response: ConversationView };
  "POST /api/projects/:project/conversation/retry": { response: Ok };
  "POST /api/projects/:project/messages": { body: { text: string }; response: Ok };
  "GET /api/projects/:project/tickets/:ticket/conversation": { response: ConversationView };
  "POST /api/projects/:project/tickets/:ticket/retry": { response: Ok };
  "POST /api/projects/:project/tickets/:ticket/messages": {
    body: { text: string; mode?: "steer" | "followUp" };
    response: Ok;
  };
  "POST /api/projects/:project/tickets/:ticket/interrupt": { response: Ok };
  "POST /api/projects/:project/questions/:question/answer": {
    body: { answer: string };
    response: Ok;
  };
};

export type RouteKey = keyof ApiRoutes;
export type RouteBody<K extends RouteKey> = ApiRoutes[K] extends { body: infer B } ? B : undefined;
export type RouteResponse<K extends RouteKey> = ApiRoutes[K]["response"];

type ParamNames<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? Name | ParamNames<`/${Rest}`>
  : P extends `${string}:${infer Name}`
    ? Name
    : never;
type PathOf<K extends RouteKey> = K extends `${string} ${infer P}` ? P : never;
export type RouteParams<K extends RouteKey> = Record<ParamNames<PathOf<K>>, string>;

export type ApiError = { error: { code: string; message: string } };

export const TOKEN_HEADER = "x-eevee-token";
