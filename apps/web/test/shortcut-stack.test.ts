import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createShortcutStack,
  SHORTCUT_PRIORITY,
  type ShortcutKeyEventLike,
} from "../src/lib/shortcut-stack.ts";

type FakeKeyEvent = ShortcutKeyEventLike & {
  readonly key: string;
  defaultPrevented: boolean;
  preventDefault(): void;
};

function makeKeyEvent(key: string, defaultPrevented = false): FakeKeyEvent {
  return {
    key,
    defaultPrevented,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

test("shortcut stack evaluates highest priority first with LIFO tie-breaking", () => {
  const stack = createShortcutStack<FakeKeyEvent>();
  const calls: string[] = [];

  stack.register({
    id: "low",
    priority: SHORTCUT_PRIORITY.BACKGROUND,
    onKeyDown: () => {
      calls.push("low");
      return false;
    },
  });
  stack.register({
    id: "mid-first",
    priority: SHORTCUT_PRIORITY.PANEL,
    onKeyDown: () => {
      calls.push("mid-first");
      return false;
    },
  });
  stack.register({
    id: "mid-second",
    priority: SHORTCUT_PRIORITY.PANEL,
    onKeyDown: () => {
      calls.push("mid-second");
      return false;
    },
  });
  stack.register({
    id: "high",
    priority: SHORTCUT_PRIORITY.OVERLAY,
    onKeyDown: () => {
      calls.push("high");
      return false;
    },
  });

  const handled = stack.dispatch(makeKeyEvent("Escape"));
  assert.equal(handled, false);
  assert.deepEqual(calls, ["high", "mid-second", "mid-first", "low"]);
});

test("shortcut stack stops propagation when handler returns true or prevents default", () => {
  const stack = createShortcutStack<FakeKeyEvent>();
  const calls: string[] = [];

  stack.register({
    id: "bg",
    priority: SHORTCUT_PRIORITY.BACKGROUND,
    onKeyDown: () => {
      calls.push("bg");
      return true;
    },
  });
  const unregReturnTrue = stack.register({
    id: "top-return",
    priority: SHORTCUT_PRIORITY.PANEL,
    onKeyDown: () => {
      calls.push("top-return");
      return true;
    },
  });

  assert.equal(stack.dispatch(makeKeyEvent("Escape")), true);
  assert.deepEqual(calls, ["top-return"]);

  unregReturnTrue();
  calls.length = 0;

  stack.register({
    id: "top-prevent",
    priority: SHORTCUT_PRIORITY.PANEL,
    onKeyDown: (event) => {
      calls.push("top-prevent");
      event.preventDefault();
      return undefined;
    },
  });

  const event = makeKeyEvent("Escape");
  assert.equal(stack.dispatch(event), true);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(calls, ["top-prevent"]);

  calls.length = 0;
  assert.equal(stack.dispatch(makeKeyEvent("Escape", true)), false);
  assert.deepEqual(calls, []);
});

test("blocksLower prevents background, rail, and chat shortcuts when settings or modal overlay is active", () => {
  const stack = createShortcutStack<FakeKeyEvent>();
  const calls: string[] = [];

  stack.register({
    id: "app-background-nav",
    priority: SHORTCUT_PRIORITY.BACKGROUND,
    onKeyDown: (event) => {
      calls.push(`nav:${event.key}`);
      return false;
    },
  });
  stack.register({
    id: "chat-interrupt-esc",
    priority: SHORTCUT_PRIORITY.PAGE,
    onKeyDown: (event) => {
      calls.push(`chat:${event.key}`);
      return false;
    },
  });
  stack.register({
    id: "right-rail-worker",
    priority: SHORTCUT_PRIORITY.PANEL,
    onKeyDown: (event) => {
      calls.push(`rail:${event.key}`);
      return false;
    },
  });

  const unregInactive = stack.register({
    id: "inactive-modal",
    active: false,
    priority: SHORTCUT_PRIORITY.MODAL,
    blocksLower: true,
    onKeyDown: () => {
      calls.push("inactive");
      return false;
    },
  });

  stack.dispatch(makeKeyEvent("f"));
  assert.deepEqual(calls, ["rail:f", "chat:f", "nav:f"]);

  calls.length = 0;
  unregInactive();

  const unregSettings = stack.register({
    id: "settings-overlay",
    active: true,
    priority: SHORTCUT_PRIORITY.OVERLAY,
    blocksLower: true,
    onKeyDown: () => {
      calls.push("settings");
      return false;
    },
  });

  assert.equal(stack.dispatch(makeKeyEvent("Escape")), false);
  assert.equal(stack.dispatch(makeKeyEvent("Escape")), false);
  assert.equal(stack.dispatch(makeKeyEvent("b")), false);
  assert.deepEqual(calls, ["settings", "settings", "settings"]);

  calls.length = 0;
  stack.register({
    id: "global-palette",
    priority: SHORTCUT_PRIORITY.GLOBAL,
    onKeyDown: (event) => {
      if (event.key === "k") {
        calls.push("palette");
        return true;
      }
      return false;
    },
  });

  assert.equal(stack.dispatch(makeKeyEvent("k")), true);
  assert.deepEqual(calls, ["palette"]);

  calls.length = 0;
  unregSettings();
  stack.dispatch(makeKeyEvent("Escape"));
  assert.deepEqual(calls, ["rail:Escape", "chat:Escape", "nav:Escape"]);
});

test("createShortcutStack attaches one shared listener and detaches on last unregister", () => {
  let listener: ((event: FakeKeyEvent) => void) | undefined;
  let attachCount = 0;
  let detachCount = 0;

  const stack = createShortcutStack<FakeKeyEvent>((fn) => {
    attachCount += 1;
    listener = fn;
    return () => {
      detachCount += 1;
      listener = undefined;
    };
  });

  const calls: string[] = [];
  const u1 = stack.register({
    id: "one",
    priority: SHORTCUT_PRIORITY.BACKGROUND,
    onKeyDown: () => {
      calls.push("one");
      return false;
    },
  });
  const u2 = stack.register({
    id: "two",
    priority: SHORTCUT_PRIORITY.PANEL,
    onKeyDown: () => {
      calls.push("two");
      return true;
    },
  });

  assert.equal(attachCount, 1);
  assert.equal(detachCount, 0);
  assert.ok(listener);

  listener(makeKeyEvent("Escape"));
  assert.deepEqual(calls, ["two"]);

  u2();
  assert.equal(detachCount, 0);

  calls.length = 0;
  listener(makeKeyEvent("Escape"));
  assert.deepEqual(calls, ["one"]);

  u1();
  assert.equal(detachCount, 1);
  assert.equal(listener, undefined);
});
