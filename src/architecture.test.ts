import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const layers: Record<string, readonly string[]> = {
  domain: [],
  shared: [],
  config: ["domain", "shared"],
  protocol: ["domain", "config"],
  engine: ["domain", "shared", "config", "protocol"],
  server: ["domain", "shared", "protocol", "engine"],
  daemon: ["domain", "shared", "config", "protocol", "engine", "server", "cli"],
  cli: ["domain", "shared", "protocol", "daemon"],
  web: ["domain", "protocol", "config"],
};

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : /\.(ts|vue)$/.test(path) ? [path] : [];
  });
}

function imports(text: string, file: string): string[] {
  const scripts = file.endsWith(".vue")
    ? [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join("\n")
    : text;
  const ast = ts.createSourceFile(file, scripts, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      found.push(node.arguments[0].text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      found.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return found;
}

function violation(file: string, specifier: string): string | undefined {
  const path = relative(root, file).split(sep);
  const layer = path[0] === "web" ? "web" : path[1];
  if (!layer || !layers[layer]) return undefined;
  const target = specifier.startsWith("@shared/")
    ? resolve(root, "src", specifier.slice("@shared/".length))
    : specifier.startsWith(".")
      ? resolve(dirname(file), specifier)
      : undefined;
  if (!target) return undefined;
  const enginePath = relative(join(root, "src/engine"), target).split(sep);
  if (
    path[0] === "src" &&
    path[1] === "engine" &&
    (path[2] === "orchestration" || path[2] === "memory") &&
    (enginePath[0] === "extensions" || enginePath[0] === "roles")
  ) {
    return `${relative(root, file)}: ${specifier} (${path[2]} -> ${enginePath[0]})`;
  }
  const destination = relative(join(root, "src"), target).split(sep);
  if (destination[0] === "..") return undefined;
  const dependency = destination[0];
  if (dependency === layer || (dependency && layers[layer].includes(dependency))) return undefined;
  return `${relative(root, file)}: ${specifier} (${layer} -> ${dependency})`;
}

test("source imports respect layer boundaries", () => {
  const violations = ["src", "web/src"].flatMap((dir) =>
    sources(join(root, dir)).flatMap((file) =>
      imports(readFileSync(file, "utf8"), file).flatMap((specifier) => {
        const error = violation(file, specifier);
        return error ? [error] : [];
      }),
    ),
  );
  assert.deepEqual(violations, [], `Layer violations:\n${violations.join("\n")}`);
});

function gitCommands(text: string): string[] {
  const ast = ts.createSourceFile("source.ts", text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const executors = new Set<string>();
  const namespaces = new Set<string>();
  const spawning = new Set(["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync"]);
  for (const statement of ast.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !["node:child_process", "child_process"].includes(statement.moduleSpecifier.text)
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const item of bindings.elements) {
        if (spawning.has(item.propertyName?.text ?? item.name.text)) executors.add(item.name.text);
      }
    } else if (bindings) namespaces.add(bindings.name.text);
    if (statement.importClause?.name) namespaces.add(statement.importClause.name.text);
  }
  const isExecutor = (node: ts.Expression): boolean =>
    ts.isIdentifier(node)
      ? executors.has(node.text)
      : ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        namespaces.has(node.expression.text) &&
        spawning.has(node.name.text);
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.arguments[0] &&
      isExecutor(node.initializer.arguments[0])
    )
      executors.add(node.name.text);
    if (ts.isCallExpression(node) && isExecutor(node.expression)) {
      const command = node.arguments[0];
      if (
        command &&
        ts.isStringLiteralLike(command) &&
        /(?:^|[;&|]\s*)(?:[^\s]*[/\\])?git(?:\.exe)?(?:\s|$)/i.test(command.text)
      )
        found.push(command.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return found;
}

test("only GitStore invokes Git in production sources", () => {
  const violations = sources(join(root, "src"))
    .filter(
      (file) =>
        !file.endsWith(".test.ts") &&
        relative(root, file).split(sep).join("/") !== "src/engine/memory/git.ts",
    )
    .flatMap((file) =>
      gitCommands(readFileSync(file, "utf8")).map(
        (command) => `${relative(root, file)}: ${command}`,
      ),
    );
  assert.deepEqual(violations, []);
});

test("Git invocation detection covers aliases, promises, namespaces and shell commands", () => {
  for (const source of [
    'import { spawn as launch } from "node:child_process"; launch("git", []);',
    'import { execFile } from "node:child_process"; const run = promisify(execFile); run("git", []);',
    'import * as cp from "node:child_process"; cp.exec("git status");',
    'import { execFileSync } from "child_process"; execFileSync("git.exe", []);',
  ])
    assert.equal(gitCommands(source).length, 1, source);
  assert.deepEqual(
    gitCommands('import { spawn } from "node:child_process"; spawn("node", []);'),
    [],
  );
});

test("boundary detection covers allowed, external, and forbidden imports", () => {
  assert.equal(violation(join(root, "src/engine/example.ts"), "../domain/index.ts"), undefined);
  assert.equal(violation(join(root, "src/domain/example.ts"), "node:fs"), undefined);
  assert.match(
    violation(join(root, "web/src/example.ts"), "@shared/engine/engine.ts") ?? "",
    /web -> engine/,
  );
  assert.deepEqual(imports("", "empty.ts"), []);
  for (const dependency of ["extensions", "roles"]) {
    assert.match(
      violation(join(root, "src/engine/memory/example.ts"), `../${dependency}/index.ts`) ?? "",
      new RegExp(`memory -> ${dependency}`),
    );
    assert.match(
      violation(join(root, "src/engine/orchestration/example.ts"), `../${dependency}/index.ts`) ??
        "",
      new RegExp(`orchestration -> ${dependency}`),
    );
    assert.match(
      violation(
        join(root, "src/engine/orchestration/nested/example.test.ts"),
        `@shared/engine/${dependency}/index.ts`,
      ) ?? "",
      new RegExp(`orchestration -> ${dependency}`),
    );
  }
  assert.equal(
    violation(join(root, "src/engine/orchestration/example.ts"), "./board.ts"),
    undefined,
  );
  assert.deepEqual(
    imports('export * from "../engine/engine.ts"; import("../config/load.ts");', "example.ts"),
    ["../engine/engine.ts", "../config/load.ts"],
  );
  assert.deepEqual(
    imports(
      '<script setup lang="ts">import type { X } from "@shared/domain/index.ts";</script>',
      "example.vue",
    ),
    ["@shared/domain/index.ts"],
  );
});
