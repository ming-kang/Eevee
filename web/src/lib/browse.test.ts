import assert from "node:assert/strict";
import { test } from "node:test";
import { pathCrumbs, splitPathQuery } from "./browse.ts";

test("pathCrumbs splits an absolute path into clickable ancestors", () => {
  assert.deepEqual(pathCrumbs("C:\\Users\\Ast\\proj"), [
    { label: "C:\\", path: "C:\\" },
    { label: "Users", path: "C:\\Users" },
    { label: "Ast", path: "C:\\Users\\Ast" },
    { label: "proj", path: "C:\\Users\\Ast\\proj" },
  ]);
  assert.deepEqual(pathCrumbs("/home/user/x"), [
    { label: "/home", path: "/home" },
    { label: "user", path: "/home/user" },
    { label: "x", path: "/home/user/x" },
  ]);
  assert.deepEqual(pathCrumbs("C:\\"), [{ label: "C:\\", path: "C:\\" }]);
  assert.deepEqual(pathCrumbs("/"), []);
  assert.deepEqual(pathCrumbs(""), []);
});

test("splitPathQuery names the directory to list and the prefix to match", () => {
  assert.deepEqual(splitPathQuery("C:\\Users\\As"), { dir: "C:\\Users\\", prefix: "As" });
  assert.deepEqual(splitPathQuery("C:\\"), { dir: "C:\\", prefix: "" });
  assert.deepEqual(splitPathQuery("/home/u"), { dir: "/home/", prefix: "u" });
  assert.equal(splitPathQuery("no-separator"), undefined);
});
