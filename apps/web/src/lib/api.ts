import { EeveeClient } from "@eevee/protocol";

export const api = new EeveeClient({
  baseUrl: "",
  credentials: "same-origin",
});

export function consumeTicketFromHash(): string | undefined {
  const hash = window.location.hash;
  if (!hash || hash.length <= 1) return undefined;
  const params = new URLSearchParams(hash.slice(1));
  const ticket = params.get("ticket")?.trim();
  if (!ticket) return undefined;
  params.delete("ticket");
  const rest = params.toString();
  const nextUrl = `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ""}`;
  window.history.replaceState(null, "", nextUrl);
  return ticket;
}
