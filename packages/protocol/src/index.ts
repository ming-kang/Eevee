import { int, obj, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";

export const PROTOCOL_VERSION = 1;

export const WorkerIdSchema = str({ pattern: "^w[1-9][0-9]*$" });
export const TicketIdSchema = str({ pattern: "^t[1-9][0-9]*$" });
export const QuestionIdSchema = str({ pattern: "^q[1-9][0-9]*$" });

export const WorkerStatusSchema = oneOf(["queued", "running", "idle", "closed"]);
export const TicketStatusSchema = oneOf(["open", "done", "cancelled"]);

export const HealthResponseSchema = obj({
  ok: oneOf([true]),
  protocolVersion: int({ minimum: 1 }),
  engineVersion: str({ minLength: 1 }),
});

export type HealthResponse = Static<typeof HealthResponseSchema>;

export const ProblemSchema = obj({
  code: str({ minLength: 1 }),
  message: str({ minLength: 1 }),
  detail: opt(str()),
});

export type Problem = Static<typeof ProblemSchema>;
