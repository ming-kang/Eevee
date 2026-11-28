# Eevee

**English** | [简体中文](README.zh-CN.md)

A proactive agent that delegates long-running work to background Workers you can watch and steer, and only interrupts you when it matters.

You talk to a single Router, which plans the work and hands it off as Tickets to reusable Workers running in parallel in the background. You can open any Worker at any time to read its full transcript and task logs, send it guidance, or stop it. Eevee is built on [Pi Durable](https://github.com/earendil-works/pi).

> **Status:** early development (v0.0.1). The local Engine, CLI, and Web UI work end to end, but APIs and data formats may change.

## Features

- **Router and Workers**: a read-only Router coordinates the work while reusable Workers run in parallel in the background and keep their context warm between Tickets.
- **Observable and steerable**: inspect, guide, or stop any Worker or background task in real time.
- **Long-term memory**: a silent Dreamer organizes Router conversations into a binary forest that can be expanded one level at a time.
- **Projects**: each project can bind multiple working directories and has its own memory and durable session store.
- **Models and MCP**: manage providers, models, MCP servers, and skills from the CLI or the Web UI.
- **Local daemon**: a supervised background Engine with crash recovery, serving a same-origin browser workbench.

## Getting Started

Requires Node.js 26 or later.

```bash
git clone https://github.com/ming-kang/Eevee.git
cd Eevee
npm install --ignore-scripts
npm run build
cd apps/cli && npm link     # puts the `eevee` command on your PATH
```

Then start the Engine and open the Web UI:

```bash
eevee start             # start the Supervisor and Engine in the background
eevee web --open        # issue a one-time login link and open the Web UI
eevee status            # show process, address, and restart count
eevee project create    # create a project
eevee stop              # stop gracefully and clean up runtime state
```

Use `eevee start --foreground` while developing or debugging to run only the Engine in the foreground, without the Supervisor. Engine data lives in `~/.eevee` by default; override it with `EEVEE_HOME`.

## Development

```bash
npm run check          # dependency and boundary checks, typecheck, lint, and tests
npm run build          # full build of TypeScript project references and the Web UI
npm run dev -- info    # run the CLI directly from source
npm run dev:web        # start the Web UI Vite dev server (proxies to the local Engine)
```

## Documentation

- [Design](DESIGN.md): vision, principles, and core concepts
- [Architecture](docs/architecture.md): packages, dependency boundaries, role extension assembly, and builds

## License

[MIT](LICENSE)
