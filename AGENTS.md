# Eevee Development Rules

## Boundaries

- Use the installed Pi packages; never vendor or copy them. Take Pi APIs from the types in `node_modules`; don't guess.
- Dependencies stay pinned to exact versions; all `@earendil-works/*` packages share one version and are upgraded together.

## Code

- Use only erasable TypeScript syntax (`erasableSyntaxOnly`): no `enum`, `namespace`, or constructor parameter properties.
- Code must run on both Windows and POSIX; take particular care with paths, shells, and processes.
- Let names, types, and file boundaries carry intent. Comment only *why*: trade-offs, workarounds, external protocols, or hidden invariants. Never narrate *what* the code already shows. Split files instead of writing section-divider comments.

## Verification

- After code changes (not docs), run `npm run check` and fix every error and warning.
- Run a single test with `node --test src/<path>.test.ts`. Fix formatting with `npm run lint:fix`.
- New features come with a test that shows the behavior; for bug fixes, write a failing reproduction first.
- When running the Engine or CLI by hand, set `EEVEE_HOME` to a temp directory; never touch `~/.eevee/`.

## Docs
- `docs/design.md`: High-level design. Omit anything already evident in code.
- Other `docs/*`: Current behavior and conventions; update alongside code changes to keep in sync.
- `CHANGELOG.md`: Log only user-visible changes since the last release under `## [Unreleased]`.

## Git

- Commit only when the user asks. Stage explicit paths; check `git status` and the staged diff before committing.
- Use Conventional Commits: `<type>[(scope)]: <summary>`.
- Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, or `--no-verify`.
