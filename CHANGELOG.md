# CHANGELOG

格式参考 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

## [Unreleased]

### Changed

- Engine discovery and API credentials now share one private runtime record, removed on shutdown.
- `eevee start --foreground` runs in the terminal; repeated starts reuse the running Engine.
- `eevee stop` waits for exit and reports a timeout as a failure.
- `eevee status` reports verified Engine identity and uptime.
