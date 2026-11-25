# Eevee Development Rules

## Boundaries

- Use the installed Pi packages; never vendor or copy them. Take Pi APIs from the types in `node_modules`; don't guess.
- Dependencies stay pinned to exact versions; all `@earendil-works/*` packages share one version and are upgraded together.

## Code

- Use only erasable TypeScript syntax (`erasableSyntaxOnly`): no `enum`, `namespace`, or constructor parameter properties.
- Code must run on both Windows and POSIX; take particular care with paths, shells, and processes.
- Use clear names and structure to carry intent.
- Don't use comments. Unless code can't express something non-obvious (a why or an external constraint), and keep it short.

## Verification

- After code changes (not docs), run `npm run check` and fix every error and warning.
- Run a single test with `node --conditions=eevee-source --test <path>.test.ts`. Fix formatting with `npm run lint:fix`.
- New features come with a test that shows the behavior; for bug fixes, write a failing reproduction first.
- When running the Engine or CLI by hand, set `EEVEE_HOME` to a temp directory.

## Docs

- `DESIGN.md`: High-level design. Omit anything already evident in code.
- `docs/architecture.md`: Workspace boundaries and subsystem architecture.
- `CHANGELOG.md`: Log only user-visible changes since the last release under `## [Unreleased]`.

## Git

- Commit only when the user asks. Stage explicit paths; check `git status` and the staged diff before committing.
- Use Conventional Commits: `<type>[(scope)]: <summary>`.
- Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, or `--no-verify`.
