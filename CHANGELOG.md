# CHANGELOG

Follow the format of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Local Engine with an authenticated `127.0.0.1` HTTP/SSE API, started with `eevee start` or `eevee start --foreground`.
- Project commands: `eevee project create | list | update | remove | memory | usage`.
- Conversation commands: `eevee send`, `eevee watch`, `eevee board`, `eevee answer`, `eevee interrupt`, `eevee retry`, and `eevee task list | read | watch | kill`.
- Management commands: `eevee auth`, `eevee provider`, `eevee models`, `eevee skills`, `eevee mcp`, and `eevee config` (including export and import).
- Local Web UI (`apps/web`) served same-origin by the Engine with one-time login links (`eevee web [--open]`), HttpOnly session cookies, live Router/Worker transcripts, Board/Tasks/Project inspector, and Engine settings.
- Background daemon lifecycle with `eevee start`, `eevee status`, and `eevee stop`: supervised crash restart, cross-platform graceful shutdown, stale-state cleanup, and automatic recovery of unfinished project work.
- Unified bash/PowerShell background task runtime with live SSE task output streaming, filtered/paged reads, steer delivery, and InboxDoc handoff.
- Global and project-level tool toggles (`--router-tools`, `--worker-tools`, `--codemode-mode`, `--codemode-inline-budget`, and Web UI settings).
- Full provider and model management (`eevee provider`, Web UI Providers tab): JSONC-preserving `models.json` CRUD, thinking-level codec, provider catalog probe, builtin model matching, and model smoke tests.
- Converged skills discovery (`eevee skills`) with 3-mode triggers (`model` / `user` / `disabled`), `/skill:` autocomplete and expansion, and upgraded MCP support (`eevee mcp`) with global and project-scoped OAuth, MCP resources tools, project overrides, role checkboxes, and live server logs.
