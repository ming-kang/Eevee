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
  type PickDirectoryRequest,
  type PickDirectoryResponse,
  PickDirectoryResponseSchema,
  type WebSessionResponse,
  WebSessionResponseSchema,
} from "../schemas/settings.ts";
import type { HttpTransport } from "./transport.ts";

export function createSettingsClient(transport: HttpTransport) {
  return {
    getWebSession(signal?: AbortSignal): Promise<WebSessionResponse> {
      return transport.get("/auth/session", WebSessionResponseSchema, signal);
    },

    createWebSession(
      input: CreateWebSessionRequest,
      signal?: AbortSignal,
    ): Promise<WebSessionResponse> {
      return transport.post("/auth/session", WebSessionResponseSchema, input, signal);
    },

    logoutWebSession(signal?: AbortSignal): Promise<OkResponse> {
      return transport.post("/auth/logout", OkResponseSchema, {}, signal);
    },

    createWebTicket(signal?: AbortSignal): Promise<CreateWebTicketResponse> {
      return transport.post("/auth/web-ticket", CreateWebTicketResponseSchema, {}, signal);
    },

    health(signal?: AbortSignal): Promise<HealthResponse> {
      return transport.get("/health", HealthResponseSchema, signal);
    },

    shutdown(signal?: AbortSignal): Promise<OkResponse> {
      return transport.post("/shutdown", OkResponseSchema, undefined, signal);
    },

    getSettings(signal?: AbortSignal): Promise<EngineSettings> {
      return transport.get("/settings", EngineSettingsSchema, signal);
    },

    patchSettings(input: EngineSettings, signal?: AbortSignal): Promise<EngineSettings> {
      return transport.patch("/settings", EngineSettingsSchema, input, signal);
    },

    putSettings(input: EngineSettings, signal?: AbortSignal): Promise<EngineSettings> {
      return transport.put("/settings", EngineSettingsSchema, input, signal);
    },

    exportConfig(signal?: AbortSignal): Promise<ConfigBundle> {
      return transport.get("/config/export", ConfigBundleSchema, signal);
    },

    importConfig(input: ConfigBundle, signal?: AbortSignal): Promise<ConfigBundle> {
      return transport.post("/config/import", ConfigBundleSchema, input, signal);
    },

    pickDirectory(
      input?: PickDirectoryRequest,
      signal?: AbortSignal,
    ): Promise<PickDirectoryResponse> {
      return transport.post("/fs/pick-directory", PickDirectoryResponseSchema, input ?? {}, signal);
    },
  };
}

export type SettingsClient = ReturnType<typeof createSettingsClient>;
