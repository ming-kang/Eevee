export function shouldCloseTicketOnEscape(context: {
  defaultPrevented: boolean;
  hasTicket: boolean;
  inEditor: boolean;
}): boolean {
  return !context.defaultPrevented && context.hasTicket && !context.inEditor;
}
