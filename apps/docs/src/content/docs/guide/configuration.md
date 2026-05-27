---
title: Configuration
description: Configure project targets, source roots, outputs, and development environment behavior.
---

Use `flue.config.ts` to describe how the Flue CLI finds and builds your project. It is the place to select a build/development target and stable filesystem locations. It is **not** runtime application configuration: models, providers, platform bindings consumed by application code, authentication, and application routing are configured in authored modules or platform configuration instead.

This guide shows how to set one consistent project configuration, override it for individual commands, and handle local environment values for Node.js and Cloudflare targets.

## Create a configuration file

Create `flue.config.ts` at the root from which you normally run Flue:

```ts title="flue.config.ts"
import { defineConfig } from '@flue/cli/config';

export default defineConfig({
  target: 'node',
  root: './',
  output: './dist',
});
```

`defineConfig()` provides TypeScript checking and editor completion for the supported configuration surface. A configuration file can set exactly these fields:

| Field | Values | Purpose |
| --- | --- | --- |
| `target` | `'node'` or `'cloudflare'` | Selects the artifact and local development integration to build. |
| `root` | Filesystem path | Selects the project root in which Flue discovers authored modules. |
| `output` | Filesystem path | Selects the generated artifact directory. |

All three fields are optional in the file, but `target` must be supplied either in configuration or with `--target` when using a command that builds the application. Keeping `target` in the file is usually best for a project committed to one deployment environment:

```ts title="flue.config.ts"
import { defineConfig } from '@flue/cli/config';

export default defineConfig({
  target: 'cloudflare',
});
```

If the same authored project is intentionally tested against both targets, leave `target` out and choose it at invocation time:

```ts title="flue.config.ts"
import { defineConfig } from '@flue/cli/config';

export default defineConfig({});
```

```bash
flue dev --target node
flue build --target cloudflare
```

Flue recognizes these configuration filenames, in this discovery order:

| Priority | Recognized file |
| --- | --- |
| 1 | `flue.config.ts` |
| 2 | `flue.config.mts` |
| 3 | `flue.config.mjs` |
| 4 | `flue.config.js` |
| 5 | `flue.config.cjs` |
| 6 | `flue.config.cts` |

Prefer `flue.config.ts` for a TypeScript project. TypeScript configuration is loaded directly by Node rather than bundled, so keep it declarative and use TypeScript syntax that can be erased at load time; runtime TypeScript constructs such as `enum`, runtime `namespace` declarations, parameter properties, and decorators are not supported in this file.

To create an initial file rather than authoring it by hand, run:

```bash
flue init --target node
```

or:

```bash
flue init --target cloudflare --root ./apps/assistant
```

`flue init` writes a starter `flue.config.ts` containing the selected target in the selected existing directory. It does not create agents, workflows, or an application entrypoint. It will not replace an already discovered `flue.config.*` file unless you pass `--force`. See the [`flue init` reference](/docs/cli/init/) and [Project Layout](/docs/guide/project-layout/) for source-module placement.

## Select a build and development target

The target tells Flue which server artifact and local development integration to prepare. Current valid targets are `node` and `cloudflare`.

| Target | Choose it when you need… | Development and command implications |
| --- | --- | --- |
| `node` | A generated Node.js server for a Node host, container, or local process. | `flue dev`, `flue build`, `flue run`, and `flue connect` can build Node output. Node local commands can load explicit `--env` files. |
| `cloudflare` | A Workers-compatible application integrated with Cloudflare/Wrangler configuration. | `flue dev` uses the Cloudflare Vite/Workers development environment and `flue build` produces Cloudflare deployment output. `flue run` and `flue connect` do not support this target. |

Set the project's normal target once:

```ts title="flue.config.ts"
import { defineConfig } from '@flue/cli/config';

export default defineConfig({
  target: 'node',
});
```

You can then omit `--target` in normal commands:

```bash
flue dev
flue build
flue run summarize --payload '{"text":"Draft release notes."}'
flue connect assistant customer-123
```

`flue run` invokes one discovered workflow through a locally built Node artifact. `flue connect` opens an interactive local connection to one discovered agent instance through a locally built Node artifact. They are useful Node-only development surfaces, not substitutes for interacting with a Cloudflare Worker. To exercise a Cloudflare application locally, start `flue dev` with a Cloudflare target and call its HTTP or WebSocket surface. See [`flue run`](/docs/cli/run/), [`flue connect`](/docs/cli/connect/), and [Routing](/docs/guide/routing/).

## Configure source root and output

`root` is the project directory that contains your Flue source layout. Within the resolved root, Flue reads source modules from one of two layouts:

- if `<root>/.flue/` exists, modules are discovered under `.flue/`, such as `.flue/agents/`, `.flue/workflows/`, and `.flue/app.ts`;
- otherwise, modules are discovered directly under the root, such as `agents/`, `workflows/`, and `app.ts`.

The layouts are alternatives: creating `.flue/` makes it the source location, and root-level agent or workflow directories are not also discovered. Current source-root selection checks for any existing `.flue` filesystem entry, so an accidental file named `.flue` also prevents root-level source discovery. See [Project Layout](/docs/guide/project-layout/) before changing a project's root or layout.

For a standalone project whose config is beside its sources, the defaults are usually sufficient:

```text
assistant/
├── flue.config.ts
├── .flue/
│   ├── agents/
│   └── workflows/
└── dist/
```

```ts title="assistant/flue.config.ts"
import { defineConfig } from '@flue/cli/config';

export default defineConfig({
  target: 'node',
});
```

Here the config directory becomes `root`, and build output defaults to `<root>/dist`.

For a source project nested below a config directory, set the root explicitly:

```text
repository/
├── flue.config.ts
├── services/
│   └── assistant/
│       └── .flue/
└── generated/
```

```ts title="flue.config.ts"
import { defineConfig } from '@flue/cli/config';

export default defineConfig({
  target: 'node',
  root: './services/assistant',
  output: './generated/assistant-server',
});
```

The configuration-file paths above are relative to the directory containing `flue.config.ts`, not relative to `root`. This matters for `output`: in this example it resolves to `repository/generated/assistant-server`, not `repository/services/assistant/generated/assistant-server`.

### Path resolution rules

| Value source | `root` resolution | `output` resolution |
| --- | --- | --- |
| Config file value | A relative value is resolved from the directory containing the selected `flue.config.*` file. | A relative value is resolved from the directory containing the selected `flue.config.*` file. |
| CLI flag | A relative `--root` value is resolved from the current working directory where you invoked `flue`. | A relative `--output` value is resolved from the current working directory where you invoked `flue`. |
| No supplied value | Defaults to the selected config file's directory, or the command's selected starting directory when no config is loaded. | Defaults to `<resolved-root>/dist`. |

A useful practical rule is to put stable project paths in `flue.config.ts` and reserve CLI path overrides for temporary output directories or monorepo automation.

## Select a configuration file and override it from the CLI

The CLI resolves build configuration per field in this order, from highest to lowest precedence:

1. CLI flags supplied for this invocation;
2. values in the loaded `flue.config.*` file;
3. built-in path defaults.

There is no default target, so resolution fails unless `target` comes from either step 1 or step 2.

```ts title="flue.config.ts"
import { defineConfig } from '@flue/cli/config';

export default defineConfig({
  target: 'node',
  root: './service',
  output: './dist/node',
});
```

```bash
flue build --output ./artifacts/preview
flue build --target cloudflare --output ./artifacts/worker
```

The first command retains `target: 'node'` and `root: './service'`, but writes output to `./artifacts/preview` relative to the invoking current working directory. The second overrides both target and output while retaining the configured root.

### Understand automatic discovery

For `dev`, `build`, `run`, and `connect`, Flue discovers a config file only in the selected starting directory:

| Invocation | Directory checked for recognized `flue.config.*` files |
| --- | --- |
| `flue build` from `/work/assistant` | `/work/assistant` |
| `flue build --root ./apps/chat` from `/work/repository` | `/work/repository/apps/chat` |
| `flue build --config ./config/flue.node.ts` from `/work/repository` | Exactly `/work/repository/config/flue.node.ts` |

Automatic discovery does **not** search parent directories. If you run from a nested directory and want a config elsewhere, invoke Flue from the intended directory, pass `--root`, or select the file explicitly with `--config`.

An explicit `--config <path>` always selects that file and resolves a relative config path from your invocation's current working directory. Fields inside the selected file are then resolved relative to that file's directory unless overridden by CLI flags:

```bash
flue build --config ./configs/flue.cloud.ts --output ./tmp/worker
```

This is useful for intentional build variants, but prefer one ordinary `flue.config.ts` when the project has one normal target and output shape.

### Know which commands consume build configuration

| Command | Relationship to configuration |
| --- | --- |
| `flue init` | Creates a `flue.config.ts`; it does not load runtime application behavior. |
| `flue dev` | Resolves the config, builds the selected target, starts its local server, and watches project changes. |
| `flue build` | Resolves the config and writes deployable artifacts to `output`. |
| `flue run <workflow>` | Resolves and builds the Node target, then performs one local workflow invocation. |
| `flue connect <agent> <instance-id>` | Resolves and builds the Node target, then opens an interactive local agent-instance connection. |

For complete option syntax, use the [CLI reference](/docs/cli/overview/).

## Load local environment files for Node.js

For Node local development and local invocation commands, pass one or more `.env`-format files with `--env`:

```bash
flue dev --target node --env .env.local
flue run summarize --target node --env .env --env .env.local \
  --payload '{"text":"Summarize this."}'
flue connect assistant customer-123 --target node --env .env.local
```

`--env` is supported for Node `flue dev`, `flue run`, and `flue connect`. These commands load values into the spawned local Node server process, where authored application/runtime code can read them. `flue build` is not an environment-file loading workflow: a generated Node server receives its production environment when you start or deploy it.

Environment file paths may be absolute or relative. Relative `--env` paths for these Node commands resolve from the configured project `root`, so placing local files beside project sources makes invocations consistent even when you start them from a workspace directory.

When values overlap, precedence is:

| Priority | Source | Example |
| --- | --- | --- |
| Highest | Existing process environment from the shell or process launching `flue` | `OPENAI_API_KEY=... flue dev --target node --env .env` |
| Middle | Later repeated `--env` files | `--env .env --env .env.local` gives `.env.local` the later-file value. |
| Lowest | Earlier repeated `--env` files | Shared local defaults in `.env`. |

For example:

```dotenv title=".env"
MODEL_REGION=us-east
API_BASE_URL=https://development.example.invalid
```

```dotenv title=".env.local"
MODEL_REGION=us-west
```

```bash
API_BASE_URL=https://override.example.invalid flue dev --target node --env .env --env .env.local
```

The local Node process receives `MODEL_REGION=us-west` from the later file and `API_BASE_URL=https://override.example.invalid` from the shell. During `flue dev`, edits to explicitly loaded env files cause the Node server to reload and reread their values.

Do not commit files containing provider credentials. Environment loading makes values available to your runtime application, but it does not automatically expose every variable to every sandboxed tool; any sandbox-specific environment exposure remains part of authored agent/runtime setup.

## Use Cloudflare local variables and Wrangler configuration

A Cloudflare target has a separate platform configuration boundary:

```ts title="flue.config.ts"
import { defineConfig } from '@flue/cli/config';

export default defineConfig({
  target: 'cloudflare',
});
```

```jsonc title="wrangler.jsonc"
{
  "$schema": "https://workers.cloudflare.com/schema/wrangler.json",
  "name": "support-assistant",
  "compatibility_date": "2026-04-01",
  "compatibility_flags": ["nodejs_compat"],
  "ai": {
    "binding": "AI"
  }
}
```

These files do different jobs:

| File | You configure… |
| --- | --- |
| `flue.config.ts` | Flue build/dev selection: `target`, `root`, and `output`. |
| `wrangler.jsonc`, `wrangler.json`, or `wrangler.toml` at the project root | Cloudflare application metadata, bindings, named environments, compatibility settings, containers, and other Wrangler-owned platform configuration. |
| Authored `app.ts`, agent, and workflow modules | Runtime provider registration, model selection, middleware, route composition, and use of platform bindings. |

For Cloudflare local development, do **not** pass `--env` to `flue dev`. Cloudflare development uses the official Vite/Workers conventions: put local values in `.dev.vars` or `.env` beside the project-root Wrangler configuration, and use `CLOUDFLARE_ENV=<name>` with environment-specific local variable files such as `.dev.vars.<name>` or `.env.<name>` when selecting a Wrangler environment.

```bash
flue dev --target cloudflare
CLOUDFLARE_ENV=staging flue dev --target cloudflare
```

When Flue builds a Cloudflare target, it reads a user Wrangler config from the project root, recognizing `wrangler.jsonc`, then `wrangler.json`, then `wrangler.toml`. Your config remains your source of truth and is not rewritten. Flue prepares an internal merged Wrangler input configuration at `.flue-vite.wrangler.jsonc` and a generated Worker entry under `.flue-vite/` for the official Cloudflare Vite integration.

The merge boundary is designed so that you maintain platform configuration while Flue supplies its required runtime wiring:

| Concern | Owner and behavior |
| --- | --- |
| Worker entrypoint | Flue sets the generated `main` entrypoint in its merged input configuration. |
| Worker name | Your Wrangler `name` is retained when present; Flue supplies a root-derived fallback when absent. |
| Compatibility requirements | Flue requires `compatibility_date` of at least `2026-04-01` if you set one and requires `nodejs_compat` in a configured `compatibility_flags` list; when absent, its merged configuration supplies required defaults. |
| Your platform bindings and settings | User-authored Wrangler settings pass into the merged configuration. Configure values such as an `AI` binding in Wrangler, then consume them from runtime code. |
| Flue durable resources | Flue adds required Durable Object bindings and SQLite migration entries for discovered agents, workflows, and its registry. Named Wrangler environments are retained and receive required generated resources. |
| Custom Durable Objects, containers, and migration maintenance | Configure application-owned resources in your Wrangler file. Do not make durable edits in `.flue-vite.wrangler.jsonc`, because it is generated build input. |

The Cloudflare build merge is only enough context to configure local development correctly. Continue to [Deploy Agents on Cloudflare](/docs/deploy/cloudflare/) for deployment, bindings, and sandbox setup. For Node-generated server deployment, see [Deploy Agents on Node.js](/docs/deploy/node/).

## Keep runtime application setup in authored modules

A `flue.config.*` file never selects a model, registers provider credentials, adds application middleware, or defines public routes. Keep those concerns in code that executes as part of your application:

| You need to configure… | Put it in… | Continue reading… |
| --- | --- | --- |
| Build target, source root, generated output | `flue.config.ts` or one-time CLI flags | This guide and the [CLI reference](/docs/cli/overview/) |
| Provider registration, model IDs, or operation model choices | Authored agent/application runtime code, including `app.ts` where provider setup is needed | [LLMs & Models](/docs/guide/models/) |
| Middleware, authentication, mounted prefixes, or custom endpoints | Authored `app.ts` and route exports | [Routing](/docs/guide/routing/) |
| Agents, workflows, and source layout | `agents/`, `workflows/`, and optional `app.ts` under the chosen source layout | [Project Layout](/docs/guide/project-layout/) |
| Cloudflare bindings and Wrangler deployment resources | Project-root Wrangler configuration | [Deploy Agents on Cloudflare](/docs/deploy/cloudflare/) |

For example, setting `target: 'cloudflare'` chooses a Cloudflare build; it does not by itself configure a Workers AI binding or select `cloudflare/<model>`. Similarly, loading `OPENAI_API_KEY` for a Node local process makes it available to runtime code that uses it; it does not select an OpenAI model for an agent. This separation keeps a portable build shape distinct from application behavior and deployment credentials.

## Typical configurations

### Node application with one committed target

```ts title="flue.config.ts"
import { defineConfig } from '@flue/cli/config';

export default defineConfig({
  target: 'node',
});
```

```bash
flue dev --env .env.local
flue run nightly-report --env .env.local --payload '{"day":"2026-05-26"}'
flue build
```

### Cloudflare application using Wrangler local values

```ts title="flue.config.ts"
import { defineConfig } from '@flue/cli/config';

export default defineConfig({
  target: 'cloudflare',
});
```

```text
assistant/
├── flue.config.ts
├── wrangler.jsonc
├── .dev.vars
├── .flue/
└── dist/
```

```bash
flue dev
flue build
```

### Workspace config for a nested source root and external output

```ts title="flue.config.ts"
import { defineConfig } from '@flue/cli/config';

export default defineConfig({
  target: 'node',
  root: './apps/support-agent',
  output: './artifacts/support-agent',
});
```

```bash
flue dev --env .env.local
flue build --output ./artifacts/support-agent-preview
```

Here `--env .env.local` is resolved from `apps/support-agent`, because environment files for Node local commands are project-root relative. The one-time `--output` value is resolved from the directory in which the CLI command is invoked, because it is a CLI override.
