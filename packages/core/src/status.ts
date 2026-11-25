import type { Context } from "@earendil-works/chord/context";
import { type DocumentReader, LiveDoc } from "@earendil-works/pi-durable";
import { hasActiveTasks } from "@eevee/agent";
import type { WorkerDocState, WorkerId, WorkerStatus } from "./docs.ts";

export function deriveWorkerStatus(input: {
  readonly worker: Pick<WorkerDocState, "id" | "closedAt">;
  readonly pendingWorkerIds: readonly WorkerId[] | ReadonlySet<WorkerId>;
  readonly hasActiveRun: boolean;
  readonly hasRunningTasks: boolean;
}): WorkerStatus {
  if (input.worker.closedAt !== undefined) return "closed";
  const pending =
    "has" in input.pendingWorkerIds
      ? input.pendingWorkerIds.has(input.worker.id)
      : input.pendingWorkerIds.includes(input.worker.id);
  if (pending) return "queued";
  if (input.hasActiveRun || input.hasRunningTasks) return "running";
  return "idle";
}

export async function resolveWorkerStatus(
  reader: DocumentReader,
  worker: WorkerDocState,
  pendingWorkerIds: readonly WorkerId[] | ReadonlySet<WorkerId>,
  context: Context,
): Promise<WorkerStatus> {
  const live = await reader.snapshot(LiveDoc, worker.conversationId, context);
  const activeTasks = await hasActiveTasks(reader, worker.conversationId, context);
  return deriveWorkerStatus({
    worker,
    pendingWorkerIds,
    hasActiveRun: live?.run !== undefined,
    hasRunningTasks: activeTasks,
  });
}
