import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldCloseTicketOnEscape } from "./rail-navigation.ts";

test("the first unhandled Escape in the Worker composer must not close the ticket before the interrupt press", () => {
  assert.equal(
    shouldCloseTicketOnEscape({ defaultPrevented: false, hasTicket: true, inEditor: true }),
    false,
  );
  assert.equal(
    shouldCloseTicketOnEscape({ defaultPrevented: true, hasTicket: true, inEditor: true }),
    false,
  );
});

test("Escape elsewhere in the rail goes back only when there is a ticket and no child handled it", () => {
  assert.equal(
    shouldCloseTicketOnEscape({ defaultPrevented: false, hasTicket: true, inEditor: false }),
    true,
  );
  assert.equal(
    shouldCloseTicketOnEscape({ defaultPrevented: true, hasTicket: true, inEditor: false }),
    false,
  );
  assert.equal(
    shouldCloseTicketOnEscape({ defaultPrevented: false, hasTicket: false, inEditor: false }),
    false,
  );
  assert.equal(
    shouldCloseTicketOnEscape({ defaultPrevented: false, hasTicket: false, inEditor: true }),
    false,
  );
});
