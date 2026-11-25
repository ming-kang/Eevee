import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  dataDirLayout,
  ENGINE_STATE_FILE,
  ENGINE_TOKEN_FILE,
  projectPaths,
  resolveDataDir,
} from "../src/index.ts";

test("resolveDataDir honors EEVEE_HOME and builds Pi-aligned layout paths", () => {
  const root = resolveDataDir({ EEVEE_HOME: "/tmp/eevee-test-home" });
  assert.equal(root, resolve("/tmp/eevee-test-home"));

  const layout = dataDirLayout(root);
  assert.equal(layout.authFile, join(root, "auth.json"));
  assert.equal(layout.modelsFile, join(root, "models.json"));
  assert.equal(layout.modelsStoreFile, join(root, "models-store.json"));
  assert.equal(layout.engineDb, join(root, "engine.sqlite"));
  assert.equal(layout.tokenFile, join(root, ENGINE_TOKEN_FILE));
  assert.equal(layout.stateFile, join(root, ENGINE_STATE_FILE));

  const project = projectPaths(layout, "demo");
  assert.equal(project.sessionDb, join(root, "projects", "demo", "session.sqlite"));
  assert.equal(project.logsDir, join(root, "projects", "demo", "logs"));
});
