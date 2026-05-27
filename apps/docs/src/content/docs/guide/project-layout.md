---
title: Project Layout
description: Organize agents, workflows, application code, and workspace context in a Flue project.
---

A Flue project contains ordinary TypeScript application code plus a small set of modules that the build discovers as agents, workflows, or an application entrypoint. Establishing the layout early makes route names predictable, keeps platform-specific integration code in the right place, and prevents a source directory from being silently ignored.

This guide uses the `.flue/` layout in examples because it creates a clear boundary for Flue-authored application modules. The root-level layout is equally supported when a project is dedicated to Flue or already uses root-level source directories.

## Choose one authored source layout

Flue resolves a **project root**, then discovers authored source from exactly one source root:

| If the resolved project root contains… | Flue discovers from… | Flue ignores for discovery…                               |
| -------------------------------------- | -------------------- | --------------------------------------------------------- |
| A `.flue/` directory                   | `<root>/.flue/`      | `<root>/agents/`, `<root>/workflows/`, and `<root>/app.*` |
| No `.flue/` directory                  | `<root>/`            | Nothing is redirected to `.flue/`                         |

**If `.flue/` exists at the resolved project root, it wins completely. Root-level authored agents, workflows, and application entrypoints are not combined with it and are not discovered.** An empty or unrelated `.flue/` directory therefore changes discovery just as a populated one does. Currently, any filesystem entry named `.flue` selects that source path, including an accidental file rather than a directory. If root-level modules unexpectedly disappear from discovery, check for and remove an unintended `.flue` file or directory before rebuilding.

Use one of these two shapes, not a mixture:

```text
my-project/
├─ package.json
├─ .flue/
│  ├─ app.ts
│  ├─ agents/
│  │  └─ support-assistant.ts
│  ├─ workflows/
│  │  └─ summarize-ticket.ts
│  ├─ connectors/
│  │  └─ ticket-system.ts
│  └─ lib/
│     └─ authorization.ts
└─ dist/
```

or:

```text
my-project/
├─ package.json
├─ app.ts
├─ agents/
│  └─ support-assistant.ts
├─ workflows/
│  └─ summarize-ticket.ts
├─ connectors/
│  └─ ticket-system.ts
├─ lib/
│  └─ authorization.ts
└─ dist/
```

In both cases, only the immediate agent files, immediate workflow files, and optional `app.*` file have discovery meaning. `connectors/`, `lib/`, prompts, schemas, provider setup, and other application code can be organized however is helpful, as long as discovered modules import what they need.

The project root remains the root for configuration and default build output even when `.flue/` is selected as the authored source root. See [Configuration](/docs/guide/configuration/) for selecting the project root, target, and output path.

### Prefer `.flue/` when integrating Flue into a larger application

A `.flue/` directory makes the Flue server surface visible at a glance and avoids colliding with unrelated `agents/` or `workflows/` directories in an existing repository. Keep application-owned code that is specific to the Flue server nearby:

```text
.flue/
├─ app.ts
├─ agents/
│  ├─ support-assistant.ts
│  └─ release-reviewer.ts
├─ workflows/
│  ├─ classify-request.ts
│  └─ produce-release-notes.ts
├─ integrations/
│  └─ github.ts
└─ shared/
   ├─ auth.ts
   └─ profiles.ts
```

This is a source organization choice, not a sandbox or deployment directory. Putting authored modules under `.flue/` does not cause an agent to read files from that directory at runtime unless your agent's sandbox and working-directory configuration makes those files available.

### Use the root-level layout for a focused Flue project

For a service whose root already represents its Flue application, the equivalent root-level layout removes one directory level:

```text
agent-service/
├─ app.ts
├─ agents/
│  └─ triage.ts
├─ workflows/
│  └─ nightly-report.ts
├─ shared/
│  └─ reporting.ts
├─ package.json
└─ dist/
```

Do not add `.flue/` later while intending to leave existing discovered modules in `agents/` or `workflows/`. As soon as `.flue/` exists, move the authored entrypoints into it or remove the directory.

## Add agent modules

Put each addressable created agent in one immediate file under the selected source root's `agents/` directory:

```text
.flue/
└─ agents/
   ├─ support-assistant.ts     discovered as support-assistant
   └─ billing-reviewer.ts      discovered as billing-reviewer
```

An agent module must default-export a value returned by `createAgent(...)`. The filename without its extension is the discovered agent name used by Flue routing and dispatch.

```ts title=".flue/agents/support-assistant.ts"
import { createAgent, type AgentRouteHandler, type AgentWebSocketHandler } from '@flue/runtime';

export const route: AgentRouteHandler = async (_c, next) => next();
export const websocket: AgentWebSocketHandler = async (_c, next) => next();

export default createAgent(({ id }) => ({
  model: 'anthropic/claude-haiku-4-5',
  instructions: `Assist the support case represented by ${id}.`,
}));
```

The exports in this example have separate purposes:

| Export                     | Purpose                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| `default createAgent(...)` | Makes this a discovered created-agent module and gives it the name `support-assistant`.         |
| `route`                    | Opts the agent into direct HTTP exposure and can enforce request policy before continuing.      |
| `websocket`                | Opts the agent into direct WebSocket exposure and can enforce upgrade policy before continuing. |

A discovered agent does not need to expose either transport. For example, application routing can import it and send accepted integration input through `dispatch(...)`, or local tooling can use it without opening a public direct-prompt route. If you expose an agent, use [Routing](/docs/guide/routing/) to add authentication and select the appropriate interaction surface. For the created-agent, instance, harness, and session model, see [Agents](/docs/concepts/agents/).

### Keep endpoint files flat and import helpers

Discovery scans immediate files in `agents/`; it does not recursively turn nested files into agents. This is useful for separating addressable behavior from implementation helpers:

```text
.flue/
├─ agents/
│  └─ support-assistant.ts        discovered agent module
└─ support/
   ├─ profile.ts                  imported helper module
   └─ case-tools.ts               imported helper module
```

```ts title=".flue/agents/support-assistant.ts"
import { createAgent } from '@flue/runtime';
import { supportProfile } from '../support/profile.ts';
import { caseTools } from '../support/case-tools.ts';

export default createAgent(() => ({
  profile: supportProfile,
  tools: caseTools,
}));
```

Do not put `agents/support/triage.ts` in place of `agents/triage.ts` expecting it to become an addressable nested endpoint. Import nested helper code into a directly discovered module instead.

## Add workflow modules

Put each finite orchestration in one immediate file under the selected source root's `workflows/` directory:

```text
.flue/
└─ workflows/
   ├─ summarize-ticket.ts        discovered as summarize-ticket
   └─ daily-report.ts            discovered as daily-report
```

A workflow module must export a callable `run(...)` value. As with agents, its filename without the extension supplies its discovered name.

```ts title=".flue/workflows/summarize-ticket.ts"
import { createAgent, type FlueContext, type WorkflowRouteHandler } from '@flue/runtime';

export const route: WorkflowRouteHandler = async (_c, next) => next();

const summarizer = createAgent(() => ({
  model: 'anthropic/claude-haiku-4-5',
}));

export async function run({ init, payload }: FlueContext<{ ticketText: string }>) {
  const harness = await init(summarizer);
  const session = await harness.session();
  const response = await session.prompt(`Summarize this ticket:\n\n${payload.ticketText}`);
  return { summary: response.text };
}
```

A workflow may also export `websocket` middleware to opt into WebSocket invocation. `route` opts into HTTP invocation. Without either exposure export, the workflow remains discoverable for local execution or application-owned use without becoming a public endpoint.

Workflows follow the same flat-entrypoint principle as agents: place reusable orchestration helpers, schemas, prompt material, connectors, and created-agent definitions elsewhere, then import them into an immediate `workflows/<name>.*` module. Read [Workflows](/docs/guide/workflows/) for choosing workflows for finite jobs and understanding workflow runs.

## Choose names and extensions that build on each target

Agent and workflow discovery accepts immediate source files ending in `.ts`, `.mts`, `.js`, or `.mjs`. Type declaration files such as `.d.ts` and `.d.mts` are not entrypoints. Keep only one source file for any discovered basename: `agents/support.ts` and `agents/support.js` would both claim the agent name `support` and the build rejects that layout. The same rule applies to workflows.

Use **lower-kebab-case** endpoint filenames when a project may target Cloudflare, including projects currently developed on Node:

```text
agents/support-assistant.ts
workflows/daily-account-review.ts
```

Cloudflare requires agent and workflow names to match names such as `support-assistant` and `daily-account-review`, beginning with a lowercase letter and continuing with lowercase letters, digits, or single hyphen-separated segments. The Cloudflare build uses these names when generating Durable Object classes and bindings, so names such as `SupportAssistant.ts`, `support_assistant.ts`, or `support--assistant.ts` fail for that target. Adopting lower-kebab-case from the start avoids renaming route identities during a future target change.

Flue also rejects names containing `:` on discovery. In practice, lower-kebab-case satisfies both the portable convention and the Cloudflare constraint.

## Add a custom application entrypoint when you need composition

Flue optionally discovers one application entrypoint directly beside `agents/` and `workflows/` in the selected source root:

```text
.flue/
├─ app.ts
├─ agents/
│  └─ support-assistant.ts
└─ workflows/
   └─ summarize-ticket.ts
```

Supported filenames are `app.ts`, `app.mts`, `app.js`, and `app.mjs`, in that preference order if more than one exists. Prefer a single `app.ts` in TypeScript projects.

You do not need `app.ts` for a basic application. Without it, the generated server creates its default application and mounts Flue's opted-in agent and workflow routes at the root path.

Add `app.ts` when you need to compose Flue with application-owned behavior, such as:

- authentication or cross-cutting middleware around a mounted path;
- inbound webhooks or chat-provider handlers that call `dispatch(...)`;
- health, status, or non-agent application routes;
- provider registration or application-wide observation;
- mounting Flue routes beneath a prefix such as `/api`.

When `app.ts` is present, **your default export owns the application request pipeline**. Flue does not add its route mount around that app. Mount `flue()` wherever direct agent and workflow routes should be served:

```ts title=".flue/app.ts"
import { flue } from '@flue/runtime/app';
import { Hono } from 'hono';

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));
app.use('/api/*', async (_c, next) => next());
app.route('/api', flue());

export default app;
```

With this mount, an HTTP-exposed `support-assistant` agent is under `/api/agents/support-assistant/<id>` rather than `/agents/support-assistant/<id>`, and an HTTP-exposed `summarize-ticket` workflow is under `/api/workflows/summarize-ticket`. Keep transport exposure and authentication intentional; [Routing](/docs/guide/routing/) covers the mounted route surfaces in more detail.

If the project uses the root-level authored layout, the same entrypoint is `app.ts` rather than `.flue/app.ts`. If `.flue/` exists, a root-level `app.ts` is not used as the Flue application entrypoint.

## Keep authored modules separate from runtime workspace context

The `.flue/` source layout can look similar to runtime agent workspace conventions, but they solve different problems:

| File or directory                                   | What it is for                                                                                  | When it is found                                                    |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `.flue/agents/`, `.flue/workflows/`, `.flue/app.ts` | Authored application modules included through build discovery when `.flue/` is the source root. | Build and development source discovery.                             |
| `<cwd>/AGENTS.md` and `<cwd>/CLAUDE.md`             | Guidance included in an initialized session's context when available in its sandbox.            | Runtime discovery from that session's configured working directory. |
| `<cwd>/.agents/skills/<name>/SKILL.md`              | Workspace skills available to a session when present in its sandbox.                            | Runtime discovery from that session's configured working directory. |

For example, a Node project using a host-backed workspace might intentionally have both:

```text
my-project/
├─ .flue/
│  ├─ agents/
│  │  └─ code-reviewer.ts
│  └─ workflows/
│     └─ review-change.ts
├─ AGENTS.md
├─ CLAUDE.md
└─ .agents/
   └─ skills/
      └─ inspect-tests/
         └─ SKILL.md
```

Here `.flue/agents/code-reviewer.ts` and `.flue/workflows/review-change.ts` define what the application builds. The other files supply workspace context only if the initialized agent's runtime `cwd` is `my-project/` in a sandbox that contains them. An agent using the default empty virtual sandbox does not see repository context merely because the files exist beside its source code.

Likewise, changing `cwd` or choosing a different sandbox changes runtime context discovery; it does not change which authored modules the CLI finds at build time. See [Sandboxes](/docs/guide/sandboxes/) when choosing the filesystem and execution boundary available to an agent.

## Build the project and recognize generated output

At least one agent or workflow module must be discovered for a build. An `app.ts` file by itself is not a complete Flue source set.

Unless you configure another output location, a build writes deployable artifacts under `<root>/dist/`, regardless of whether authored modules came from `<root>/` or `<root>/.flue/`:

```text
my-project/
├─ .flue/
│  ├─ agents/
│  │  └─ support-assistant.ts
│  └─ app.ts
└─ dist/
```

For a Node target, the generated application server is emitted as `dist/server.mjs` (with its build artifacts). The generated server imports discovered modules, validates their required exports at startup, and serves either the default application or your custom `app.ts` composition.

For a Cloudflare target, Flue prepares a generated Worker entry and merged Wrangler input for the official Cloudflare Vite build integration. During that process, generated intermediary files are anchored at the project root, including `.flue-vite/_entry.ts` and `.flue-vite.wrangler.jsonc`; these are build machinery, not an authored `.flue/` layout. The deployable build output is written under the configured output directory, which defaults to `dist/`, while your Wrangler configuration remains a project-root concern.

A practical starting structure for an application intended to run on either Node or Cloudflare is therefore:

```text
my-project/
├─ .flue/
│  ├─ app.ts
│  ├─ agents/
│  │  └─ support-assistant.ts
│  ├─ workflows/
│  │  └─ summarize-ticket.ts
│  └─ shared/
│     └─ authorization.ts
├─ package.json
├─ wrangler.jsonc              used when targeting Cloudflare
└─ dist/                       generated output
```

Use lower-kebab-case discovered filenames, keep endpoint modules flat, import implementation helpers from nearby source modules, and choose either `.flue/` or root-level discovery before adding routes. That keeps the authored application portable while leaving runtime context, route composition, and target-specific output explicit.
