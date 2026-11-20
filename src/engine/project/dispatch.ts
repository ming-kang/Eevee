import type { Context } from "@earendil-works/chord/context";
import type { Conversation, Harness, Tx } from "@earendil-works/pi-durable";
import { deliver, type EngineEvent, route } from "../orchestration/index.ts";
import { deliveryHost } from "../scheduler.ts";

export type Dispatch = (event: EngineEvent, change?: (tx: Tx) => Promise<void>) => Promise<void>;

export function createDispatcher(harness: Harness, root: Conversation, context: Context): Dispatch {
  return (event, change) => deliver(deliveryHost(harness, root), route(event), context, change);
}
