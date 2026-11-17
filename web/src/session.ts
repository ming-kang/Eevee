import { type Client, createClient } from "@shared/api/client.ts";

const STORAGE_KEY = "eevee.token";

export class Unauthorized extends Error {
  override name = "Unauthorized";
}

export async function openSession(): Promise<Client> {
  const code = new URLSearchParams(location.hash.slice(1)).get("code");
  if (code) {
    history.replaceState(null, "", location.pathname + location.search);
    const { token } = await createClient({ baseUrl: location.origin }).call("POST /api/session", {
      code,
    });
    sessionStorage.setItem(STORAGE_KEY, token);
  }
  const token = sessionStorage.getItem(STORAGE_KEY);
  if (!token) throw new Unauthorized("还没有授权：在终端运行 eevee web 打开面板。");
  const client = createClient({ baseUrl: location.origin, token });
  await client.call("GET /api/status");
  return client;
}

export function forgetSession(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}
