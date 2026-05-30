---
title: flue run
description: Reference for executing one workflow invocation from the command line.
---

## Synopsis

```bash
flue run <workflow> [--target node] [--payload <json>] [--root <path>] [--output <path>] [--config <path>] [--env <path>]
```

## Description

`flue run` builds the selected Node project and executes one discovered workflow locally. It uses private child-process communication, so the workflow does not need public HTTP or WebSocket exposure and application ingress middleware is not executed.

A workflow invocation is a finite run with a run ID. Use it for local scripts and CI tasks, not interactive agent sessions.

## Options

- `--payload <json>` supplies the workflow payload. Defaults to `{}`.
- `--root <path>` selects the project root.
- `--output <path>` selects the build output directory.
- `--config <path>` selects a Flue configuration file.
- `--env <path>` selects one alternate environment file loaded before configuration; without it, project-root `.env` is loaded when present.
- `--target node` selects the supported local execution target.

## Output and events

Progress, run identity, and streamed events are written to stderr. A successful terminal workflow result is written as JSON to stdout.

## Target support

Local `flue run` supports Node builds. Cloudflare-target workflows must be exercised through a Workers runtime, such as `flue dev --target cloudflare` and their public ingress surface.

## Examples

```bash
flue run hello --target node
flue run summarize --target node --payload '{"text":"hello"}' --env .env.staging
```
