# CHANGELOG

Follow the format of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Local Engine with an authenticated `127.0.0.1` HTTP/SSE API, started with `eevee start` or `eevee start --foreground`.
- Project commands: `eevee project create | list | update | remove | memory | usage`.
- Conversation commands: `eevee send`, `eevee watch`, `eevee board`, `eevee answer`, `eevee interrupt`, `eevee retry`, and `eevee task read | kill`.
- Management commands: `eevee auth`, `eevee models`, `eevee mcp`, and `eevee config` (including export and import).
- Background daemon lifecycle with `eevee start`, `eevee status`, and `eevee stop`: supervised crash restart, cross-platform graceful shutdown, stale-state cleanup, and automatic recovery of unfinished project work.
