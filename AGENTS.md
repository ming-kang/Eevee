# Eevee Development Rules

Eevee is a proactive agent: a Router dispatches tickets, Workers execute them in the background, and lessons go into a Git-backed memory. It is built on [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable), and Node 26 runs the TypeScript sources directly.

docs/design is the source of truth

## Boundaries

- Use the installed Pi packages; never vendor or copy them. Take Pi APIs from the types in `node_modules`; don't guess.
- Dependencies stay pinned to exact versions; all `@earendil-works/*` packages share one version and are upgraded together.

## Code

- Use only erasable TypeScript syntax (`erasableSyntaxOnly`): no `enum`, `namespace`, or constructor parameter properties.
- Code must run on both Windows and POSIX; take particular care with paths, shells, and processes.

## Verification

- After code changes (not docs), run `npm run check` and fix every error and warning.
- Run a single test with `node --test src/<path>.test.ts`. Fix formatting with `npm run lint:fix`.
- New features come with a test that shows the behavior; for bug fixes, write a failing reproduction first.
- When running the Engine or CLI by hand, set `EEVEE_HOME` to a temp directory; never touch `~/.eevee/`.

## Docs

- `CHANGELOG.md` lists under `## [Unreleased]` only user-visible changes relative to the last released version.

## Git

- Commit only when the user asks. Stage explicit paths; check `git status` and the staged diff before committing.
- Use Conventional Commits: `<type>[(scope)]: <summary>`.
- Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, or `--no-verify`.
