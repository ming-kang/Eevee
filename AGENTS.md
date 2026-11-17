# Eevee Development Rules

Eevee is a proactive agent: a Router dispatches tickets, Workers execute them in the background, and lessons go into a Git-backed memory. It is built on [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable), and Node 26 runs the TypeScript sources directly.

Read as needed before making changes:

- [docs/development.md](docs/development.md): scripts, module layout, and engineering rules.
- [docs/design/](docs/design/): product goals and behavior contracts. Read the relevant one before changing behavior.

## Boundaries

- Extensions never import each other; they depend only on `src/contracts/`. Capabilities an extension needs from outside are declared as ports and injected by `ProjectHost`.
- Anything needed after a reset must live in durable state.
- Each store has exactly one write path.
- Use the installed Pi packages; never vendor or copy them. Take Pi APIs from the types in `node_modules`; don't guess. Fix type errors by upgrading dependencies, not by removing code.
- Dependencies stay pinned to exact versions; all `@earendil-works/*` packages share one version and are upgraded together.

## Code

- Use only erasable TypeScript syntax (`erasableSyntaxOnly`): no `enum`, `namespace`, or constructor parameter properties.
- Code must run on both Windows and POSIX; take particular care with paths, shells, and processes.

## Verification

- After code changes (not docs), run `npm run check` and fix every error and warning.
- Run a single test with `node --test src/<path>.test.ts`. Fix formatting with `npm run lint:fix`.
- Tests run offline, no ne real credentials or paid models.
- New features come with a test that shows the behavior; for bug fixes, write a failing reproduction first.
- When running the Engine or CLI by hand, set `EEVEE_HOME` to a temp directory; never touch the user's `~/.eevee/`.

## Docs

- Document user-visible changes in `docs/` and in `CHANGELOG.md` under `## [Unreleased]`.
- Docs describe only implemented behavior, with `src/` as the source of truth. Register new pages in `docs/docs.json`.
- Docs don't cover Pi Durable internals; link to Durable's docs instead.

## Git

- Commit only when the user asks. Stage explicit paths (`git add <path>`); check `git status` and the staged diff before committing.
- Use Conventional Commits: `<type>[(scope)]: <summary>`.
- Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, or `--no-verify`.
