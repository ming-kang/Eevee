import { PROTOCOL_VERSION } from "@eevee/protocol";

export const ENGINE_VERSION = "0.0.1";
export const ENGINE_PROTOCOL_VERSION = PROTOCOL_VERSION;

export {
  type DataDirLayout,
  dataDirLayout,
  ENGINE_DB_FILE,
  PROJECT_DB_FILE,
  type ProjectPaths,
  projectPaths,
  resolveDataDir,
} from "./data-dir.ts";
