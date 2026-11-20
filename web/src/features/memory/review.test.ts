import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryProposal } from "../../../../src/domain/index.ts";
import { createClient } from "../../../../src/protocol/client.ts";
import { createProposalReview } from "./review.ts";

function fixture(options: { stale?: boolean; empty?: boolean; fail?: boolean } = {}) {
  const proposal: MemoryProposal = {
    id: "m1",
    scope: "global",
    source: { kind: "dreaming", ticketId: "t1" },
    conversationId: 42,
    summary: "Advice",
    actions: [{ action: "write", file: "MEMORY.md", content: "new" }],
    status: "pending",
    createdAt: 1,
  };
  const requests: { path: string; body: unknown }[] = [];
  let changed = 0;
  const review = createProposalReview(
    createClient({
      baseUrl: "http://localhost",
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (options.fail) throw new Error("offline");
        if (path.endsWith("/approve")) {
          if (options.stale) {
            proposal.status = "stale";
            return Response.json(
              { code: "memory_changed", file: "MEMORY.md", status: 409, title: "Changed" },
              { status: 409 },
            );
          }
          proposal.status = "approved";
          return Response.json({ id: 2 });
        }
        if (path.endsWith("/reject")) {
          proposal.status = "rejected";
          proposal.reason = String(
            (JSON.parse(String(init?.body)) as { reason?: string }).reason ?? "",
          );
          return new Response(null, { status: 204 });
        }
        return Response.json(
          path.endsWith("/proposals")
            ? { proposals: options.empty ? [] : [proposal] }
            : {
                ...proposal,
                files: [
                  {
                    path: "MEMORY.md",
                    status: "modified",
                    added: 1,
                    removed: 1,
                    hunks: [
                      { header: "@@ -1 +1 @@", lines: [{ kind: "add", new: 1, text: "new" }] },
                    ],
                  },
                ],
              },
        );
      },
    }),
    async () => {
      changed++;
    },
  );
  return {
    review,
    requests,
    get changed() {
      return changed;
    },
  };
}

test("proposal review lists both scopes, loads diffs, approves once and keeps decided history", async () => {
  const f = fixture();
  await f.review.load("p1");
  assert.equal(f.review.proposals.value[0]?.scope, "global");
  assert.equal(f.review.detail.value?.files[0]?.hunks[0]?.lines[0]?.text, "new");
  await Promise.all([f.review.approve(), f.review.approve()]);
  assert.equal(f.requests.filter((r) => r.path.endsWith("/approve")).length, 1);
  assert.equal(f.changed, 1);
  assert.equal(f.review.detail.value?.status, "approved");
  await f.review.reject();
  assert.equal(f.requests.filter((r) => r.path.endsWith("/reject")).length, 0);
});

test("reject sends an optional trimmed reason, or an empty object", async () => {
  for (const reason of ["  Keep it  ", ""]) {
    const f = fixture();
    await f.review.load("p1");
    f.review.reason.value = reason;
    await f.review.reject();
    assert.deepEqual(
      f.requests.find((r) => r.path.endsWith("/reject"))?.body,
      reason ? { reason: "Keep it" } : {},
    );
    assert.equal(f.review.detail.value?.status, "rejected");
    assert.equal(f.changed, 1);
  }
});

test("refreshing proposals while reviewing does not discard a rejection reason", async () => {
  const f = fixture();
  await f.review.load("p1");
  f.review.reason.value = "Keep this wording";
  await f.review.load("p1");
  assert.equal(f.review.reason.value, "Keep this wording");
  await f.review.reject();
  assert.deepEqual(f.requests.find((r) => r.path.endsWith("/reject"))?.body, {
    reason: "Keep this wording",
  });
});

test("a stale approval reloads the decision and shows an error without reporting a save", async () => {
  const f = fixture({ stale: true });
  await f.review.load("p1");
  await f.review.approve();
  assert.equal(f.review.detail.value?.status, "stale");
  assert.ok(f.review.error.value);
  assert.equal(f.changed, 0);
  assert.equal(f.review.busy.value, false);
});

test("empty lists and failed requests leave no actionable selection", async () => {
  for (const options of [{ empty: true }, { fail: true }]) {
    const f = fixture(options);
    await f.review.load("p1");
    assert.equal(f.review.detail.value, undefined);
    assert.deepEqual(f.review.proposals.value, []);
    assert.equal(Boolean(f.review.error.value), "fail" in options);
    await f.review.approve();
    assert.equal(f.changed, 0);
  }
});

test("a late response from a previous project cannot replace the current selection", async () => {
  let release: (response: Response) => void = () => {};
  const review = createProposalReview(
    createClient({
      baseUrl: "http://localhost",
      fetch: async (input) => {
        if (String(input).includes("/p1/"))
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        return Response.json({ proposals: [] });
      },
    }),
  );
  const first = review.load("p1");
  await review.load("p2");
  release(Response.json({ proposals: [{ id: "m1", status: "pending" }] }));
  await first;
  assert.deepEqual(review.proposals.value, []);
  assert.equal(review.detail.value, undefined);
});
