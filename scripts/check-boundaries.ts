import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export const ALLOWED_WORKSPACE_DEPS: Readonly<Record<string, readonly string[]>> = {
  "@eevee/agent": [],
  "@eevee/memory": [],
  "@eevee/core": ["@eevee/agent", "@eevee/memory"],
  "@eevee/protocol": [],
  "@eevee/engine": ["@eevee/agent", "@eevee/memory", "@eevee/core", "@eevee/protocol"],
  "@eevee/cli": ["@eevee/protocol", "@eevee/engine"],
};

const CORE_FORBIDDEN_IMPORTS = new Set([
  "node:sqlite",
  "node:http",
  "node:https",
  "node:net",
  "ws",
]);

const PROTOCOL_FORBIDDEN_IMPORTS = new Set([
  "node:sqlite",
  "node:http",
  "node:https",
  "node:fs",
  "node:fs/promises",
  "node:child_process",
  "child_process",
  "node:net",
  "ws",
]);

const SPAWNING_FNS = new Set([
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "spawn",
  "spawnSync",
]);

const posix = (value: string): string => value.split(sep).join("/");

export function extractSpecifiers(sourceText: string, fileName = "source.ts"): string[] {
  const ast = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const found: string[] = [];

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      found.push(node.arguments[0].text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      found.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(ast);
  return found;
}

export function extractGitInvocations(sourceText: string, fileName = "source.ts"): string[] {
  const ast = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const executors = new Set<string>();
  const namespaces = new Set<string>();

  for (const statement of ast.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !["node:child_process", "child_process"].includes(statement.moduleSpecifier.text)
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const item of bindings.elements) {
        if (SPAWNING_FNS.has(item.propertyName?.text ?? item.name.text)) {
          executors.add(item.name.text);
        }
      }
    } else if (bindings) {
      namespaces.add(bindings.name.text);
    }
    if (statement.importClause?.name) namespaces.add(statement.importClause.name.text);
  }

  const isExecutor = (node: ts.Expression): boolean =>
    ts.isIdentifier(node)
      ? executors.has(node.text)
      : ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        namespaces.has(node.expression.text) &&
        SPAWNING_FNS.has(node.name.text);

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.arguments[0] &&
      isExecutor(node.initializer.arguments[0])
    ) {
      executors.add(node.name.text);
    }
    if (ts.isCallExpression(node) && isExecutor(node.expression)) {
      const command = node.arguments[0];
      if (
        command &&
        ts.isStringLiteralLike(command) &&
        /(?:^|[;&|]\s*)(?:[^\s]*[/\\])?git(?:\.exe)?(?:\s|$)/i.test(command.text)
      ) {
        found.push(command.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(ast);
  return found;
}

function packageOfSpecifier(specifier: string): string | undefined {
  if (!specifier.startsWith("@eevee/")) return undefined;
  const parts = specifier.split("/");
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined;
}

function extensionDirOf(relPath: string): string | undefined {
  const match = /^src\/extensions\/([^/]+)\//.exec(relPath);
  return match?.[1];
}

export type SourceCheckInput = {
  workspaceName: string;
  workspaceDir: string;
  file: string;
  sourceText: string;
  declaredDeps: ReadonlySet<string>;
};

export function checkSource(input: SourceCheckInput): string[] {
  const { workspaceName, workspaceDir, file, sourceText, declaredDeps } = input;
  const violations: string[] = [];
  const relInWorkspace = posix(relative(workspaceDir, file));
  const isTest = relInWorkspace.startsWith("test/") || relInWorkspace.endsWith(".test.ts");
  const isSrc = relInWorkspace.startsWith("src/") && !isTest;
  const label = `${workspaceName}:${relInWorkspace}`;
  const allowedDeps = ALLOWED_WORKSPACE_DEPS[workspaceName] ?? [];

  for (const specifier of extractSpecifiers(sourceText, file)) {
    if (/^\.\.?\//.test(specifier) && /\.js(?:[?#].*)?$/.test(specifier)) {
      violations.push(`${label}: relative .js import "${specifier}" is forbidden (use .ts)`);
    }

    if (specifier === "@earendil-works/chord") {
      violations.push(
        `${label}: "@earendil-works/chord" root host runtime is forbidden (use /context, /watch, /json)`,
      );
    }

    if (specifier.startsWith(".")) {
      const resolved = resolve(dirname(file), specifier);
      const relTarget = posix(relative(workspaceDir, resolved));
      if (relTarget.startsWith("..") || relTarget === "..") {
        violations.push(`${label}: relative import "${specifier}" escapes workspace boundary`);
      } else if (workspaceName === "@eevee/agent" && isSrc) {
        const fromExt = extensionDirOf(relInWorkspace);
        const toExt = extensionDirOf(relTarget);
        if (fromExt && toExt && fromExt !== toExt) {
          violations.push(
            `${label}: extension "${fromExt}" must not import sibling extension "${toExt}"`,
          );
        }
      }
      continue;
    }

    const targetWorkspace = packageOfSpecifier(specifier);
    if (targetWorkspace && targetWorkspace !== workspaceName && isSrc) {
      if (!allowedDeps.includes(targetWorkspace)) {
        violations.push(
          `${label}: forbidden workspace dependency ${workspaceName} -> ${targetWorkspace}`,
        );
      } else if (!declaredDeps.has(targetWorkspace)) {
        violations.push(
          `${label}: undeclared workspace dependency "${targetWorkspace}" (add to package.json)`,
        );
      }
    }

    if (isSrc) {
      if (
        (workspaceName === "@eevee/core" || workspaceName === "@eevee/memory") &&
        CORE_FORBIDDEN_IMPORTS.has(specifier)
      ) {
        violations.push(
          `${label}: ${workspaceName} must stay storage/transport-agnostic (forbids "${specifier}")`,
        );
      }
      if (workspaceName === "@eevee/protocol" && PROTOCOL_FORBIDDEN_IMPORTS.has(specifier)) {
        violations.push(
          `${label}: @eevee/protocol must stay runtime-neutral (forbids "${specifier}")`,
        );
      }
    }
  }

  if (isSrc) {
    for (const command of extractGitInvocations(sourceText, file)) {
      violations.push(`${label}: production source must not invoke git ("${command}")`);
    }
  }

  return violations;
}

export function checkWorkspaceManifest(input: {
  workspaceName: string;
  dependencies?: Record<string, string>;
}): string[] {
  const violations: string[] = [];
  const allowed = ALLOWED_WORKSPACE_DEPS[input.workspaceName];
  if (allowed === undefined) {
    violations.push(
      `Unknown workspace package "${input.workspaceName}" is missing from ALLOWED_WORKSPACE_DEPS`,
    );
    return violations;
  }
  for (const dep of Object.keys(input.dependencies ?? {})) {
    if (!dep.startsWith("@eevee/")) continue;
    if (!allowed.includes(dep)) {
      violations.push(
        `${input.workspaceName}/package.json: forbidden workspace dependency -> ${dep}`,
      );
    }
  }
  return violations;
}

function collectTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collectTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      found.push(full);
    }
  }
  return found;
}

function runCli(): void {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const violations: string[] = [];

  for (const group of ["packages", "apps"]) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const workspaceDir = join(base, entry.name);
      const manifestPath = join(workspaceDir, "package.json");
      if (!existsSync(manifestPath)) continue;
      const pkg = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        name: string;
        dependencies?: Record<string, string>;
      };
      const workspaceName = pkg.name;
      const declaredDeps = new Set(Object.keys(pkg.dependencies ?? {}));

      violations.push(...checkWorkspaceManifest({ workspaceName, dependencies: pkg.dependencies }));

      for (const file of collectTsFiles(workspaceDir)) {
        violations.push(
          ...checkSource({
            workspaceName,
            workspaceDir,
            file,
            sourceText: readFileSync(file, "utf8"),
            declaredDeps,
          }),
        );
      }
    }
  }

  for (const file of collectTsFiles(join(root, "scripts"))) {
    const sourceText = readFileSync(file, "utf8");
    for (const specifier of extractSpecifiers(sourceText, file)) {
      if (/^\.\.?\//.test(specifier) && /\.js(?:[?#].*)?$/.test(specifier)) {
        violations.push(
          `${posix(relative(root, file))}: relative .js import "${specifier}" is forbidden (use .ts)`,
        );
      }
    }
  }

  if (violations.length > 0) {
    console.error("Boundary check failed:");
    for (const violation of violations) console.error(`  - ${violation}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli();
}
