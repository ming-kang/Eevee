import type { Context } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { type JobId, ProblemError } from "../../domain/index.ts";
import type { JobLogView } from "../../protocol/contract.ts";
import { JobDoc } from "../docs.ts";
import { JOB_LOG_DEFAULT_LINES, type JobHost, readLogTail } from "../jobs.ts";

type Deps = {
  harness: Harness;
  context: Context;
  jobs: Pick<JobHost, "kill">;
  jobLogPath: (id: JobId) => string;
};
export class Jobs {
  readonly #deps: Deps;
  constructor(deps: Deps) {
    this.#deps = deps;
  }
  async kill(id: JobId): Promise<void> {
    if (await this.#deps.jobs.kill(id)) return;
    const job = await this.#deps.harness.snapshot(JobDoc, id, this.#deps.context);
    if (job === undefined) throw new ProblemError({ code: "no_job", jobId: id });
    throw new ProblemError({ code: "job_ended", jobId: id });
  }

  async log(id: JobId, maxLines = JOB_LOG_DEFAULT_LINES): Promise<JobLogView> {
    const job = await this.#deps.harness.snapshot(JobDoc, id, this.#deps.context);
    if (job === undefined) throw new ProblemError({ code: "no_job", jobId: id });
    const tail = await readLogTail(this.#deps.jobLogPath(id), maxLines);
    return { job, ...tail };
  }
}
