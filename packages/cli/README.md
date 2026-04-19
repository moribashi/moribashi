# @moribashi/cli

> **Experimental — stub package.** Reserves the `@moribashi/cli` name for a future CLI integration. No runtime functionality yet; do not depend on its surface.

## Install

```sh
pnpm add @moribashi/cli
```

## Status

This package is a placeholder. When Moribashi ships a CLI integration (command scaffolding, lifecycle hooks for long-running CLI processes), it will land here. Until then, its exports are intentionally minimal and considered `@experimental` — no semver guarantees.

## Roadmap

- Define a `CliPlugin` pattern mirroring `@moribashi/web`
- Per-command scope lifecycle
- Signal handling integrated with `app.stop()`
