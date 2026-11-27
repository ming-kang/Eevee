import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createDisclosureState,
  stepDisclosureOnLiveChange,
  stepDisclosureOnUserToggle,
} from "../src/components/transcript/useAutoExpandDisclosure.ts";
import { outlineEntries } from "../src/lib/transcript.ts";

describe("useAutoExpandDisclosure state machine", () => {
  it("opens while streaming and auto-collapses on completion when user never toggled", () => {
    let state = createDisclosureState(true);
    assert.equal(state.open, true);
    assert.equal(state.userInteracted, false);

    state = stepDisclosureOnLiveChange(state, false);
    assert.equal(state.open, false);
    assert.equal(state.wasLive, false);
  });

  it("respects manual collapse while streaming and stays closed on completion", () => {
    let state = createDisclosureState(true);
    state = stepDisclosureOnUserToggle(state, false);
    assert.equal(state.open, false);
    assert.equal(state.userInteracted, true);

    state = stepDisclosureOnLiveChange(state, false);
    assert.equal(state.open, false);
  });

  it("respects manual expand after completion and keeps it open", () => {
    let state = createDisclosureState(false);
    assert.equal(state.open, false);

    state = stepDisclosureOnUserToggle(state, true);
    assert.equal(state.open, true);

    state = stepDisclosureOnLiveChange(state, false);
    assert.equal(state.open, true);
  });

  it("opens immediately when forceOpen fires (e.g. error or revealed edit)", () => {
    let state = createDisclosureState(false);
    state = stepDisclosureOnLiveChange(state, false, true);
    assert.equal(state.open, true);
  });
});

describe("outlineEntries proportional weights and sections", () => {
  it("computes sm/md/lg weights and extracts heading sections for structured replies", () => {
    const entries = outlineEntries([
      { kind: "user", key: "u1", id: 1, text: "Short question" },
      { kind: "assistant", key: "a1", text: "Short answer" },
      { kind: "user", key: "u2", id: 2, text: "Design plan" },
      {
        kind: "assistant",
        key: "a2",
        text: `# Architecture\n\n${"details ".repeat(180)}\n\n## Storage\n\nMore details\n\n### Cache\n\nNotes`,
      },
    ]);

    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.weight, "sm");
    assert.equal(entries[0]?.sections, undefined);
    assert.equal(entries[1]?.weight, "lg");
    assert.equal(entries[1]?.sections?.length, 3);
    assert.deepEqual(
      entries[1]?.sections?.map((s) => ({ depth: s.depth, text: s.text })),
      [
        { depth: 1, text: "Architecture" },
        { depth: 2, text: "Storage" },
        { depth: 3, text: "Cache" },
      ],
    );
  });
});
