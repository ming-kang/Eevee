import {
  type HealthResponse,
  HealthResponseSchema,
  type OkResponse,
  OkResponseSchema,
} from "../schemas/common.ts";
import {
  type ConfigBundle,
  ConfigBundleSchema,
  type CreateWebSessionRequest,
  type CreateWebTicketResponse,
  CreateWebTicketResponseSchema,
  type EngineSettings,
  EngineSettingsSchema,
  type WebSessionResponse,
  WebSessionResponseSchema,
} from "../schemas/settings.ts";
import type { HttpTransport } from "./transport.ts";

export class SettingsClient {
  readonly #transport: HttpTransport;

  constructor(transport: HttpTransport) {
    this.#transport = transport;
  }

  getWebSession(signal?: AbortSignal): Promise<WebSessionResponse> {
    return this.#transport.get("/auth/session", WebSessionResponseSchema, signal);
  }

  createWebSession(
    input: CreateWebSessionRequest,
    signal?: AbortSignal,
  ): Promise<WebSessionResponse> {
    return this.#transport.post("/auth/session", WebSessionResponseSchema, input, signal);
  }

  logoutWebSession(signal?: AbortSignal): Promise<OkResponse> {
    return this.#transport.post("/auth/logout", OkResponseSchema, {}, signal);
  }

  createWebTicket(signal?: AbortSignal): Promise<CreateWebTicketResponse> {
    return this.#transport.post("/auth/web-ticket", CreateWebTicketResponseSchema, {}, signal);
  }

  health(signal?: AbortSignal): Promise<HealthResponse> {
    return this.#transport.get("/health", HealthResponseSchema, signal);
  }

  shutdown(signal?: AbortSignal): Promise<OkResponse> {
    return this.#transport.post("/shutdown", OkResponseSchema, undefined, signal);
  }

  getSettings(signal?: AbortSignal): Promise<EngineSettings> {
    return this.#transport.get("/settings", EngineSettingsSchema, signal);
  }

  patchSettings(input: EngineSettings, signal?: AbortSignal): Promise<EngineSettings> {
    return this.#transport.patch("/settings", EngineSettingsSchema, input, signal);
  }

  putSettings(input: EngineSettings, signal?: AbortSignal): Promise<EngineSettings> {
    return this.#transport.put("/settings", EngineSettingsSchema, input, signal);
  }

  exportConfig(signal?: AbortSignal): Promise<ConfigBundle> {
    return this.#transport.get("/config/export", ConfigBundleSchema, signal);
  }

  importConfig(input: ConfigBundle, signal?: AbortSignal): Promise<ConfigBundle> {
    return this.#transport.post("/config/import", ConfigBundleSchema, input, signal);
  }
}
