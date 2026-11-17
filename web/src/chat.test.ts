import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatLine } from "@shared/api/contract.ts";
import { toBlocks } from "./chat.ts";

const line = (id: number, role: ChatLine["role"], text: string): ChatLine => ({ id, role, text });

test("连续的过程合并成一组，消息单独成块", () => {
  const blocks = toBlocks([
    line(1, "reset", "开篇"),
    line(2, "user", "帮我写个脚本"),
    line(3, "assistant", "[调用 ticket]"),
    line(4, "tool", "已创建 t1"),
    line(5, "assistant", "已经交给 t1 了。"),
  ]);
  assert.deepEqual(
    blocks.map((b) => (b.kind === "message" ? b.line.id : b.lines.map((l) => l.id))),
    [[1], 2, [3, 4], 5],
  );
});
