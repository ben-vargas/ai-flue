---
title: flue connect
description: Reference for opening an interactive local agent-instance session from the command line.
---

## Synopsis

```bash
flue connect <agent> <instance-id> [--target node] [--session <name>] [--root <path>] [--output <path>] [--config <path>] [--env <path>]
```

## Description

`flue connect` builds the selected Node project and opens a local connection to one discovered agent instance. Enter one prompt per line; the connection remains open until end-of-input or interruption so in-memory instance and session state can be reused between prompts.

The local connection uses private child-process communication. The agent does not need public HTTP or WebSocket exposure, and public application ingress middleware is not executed.

## Options

- `--session <name>` selects the session used by each entered prompt. Defaults to `default`.
- `--root <path>` selects the project root.
- `--output <path>` selects the build output directory.
- `--config <path>` selects a Flue configuration file.
- `--env <path>` selects one alternate environment file loaded before configuration; without it, project-root `.env` is loaded when present.
- `--target node` selects the supported local execution target.

## Target support

Local `flue connect` supports Node builds. Connecting to an existing deployed or Cloudflare-hosted server will be supported separately through the public WebSocket interface.

## Examples

```bash
flue connect assistant customer-123 --target node
flue connect assistant customer-123 --session support --env .env.staging
```
