---
title: Harness
description: Initialize configured agent environments, manage sessions, prepare context, and control state and compaction.
---

A **harness** is the initialized environment in which an agent does work. It combines a created agent's configured behavior with its runtime workspace, available capabilities, named sessions, and conversation-state storage.

Use a harness when you need to:

- initialize a created agent inside a workflow;
- continue or isolate conversations through named sessions;
- stage files or run setup commands in the agent's configured workspace;
- make workspace instructions and skills available at initialization time; or
- control how long conversations retain context through persistence and compaction.

This guide concentrates on constructing and using that environment. Continue to [Prompting](/docs/guide/prompting/) for prompt results and cancellation, [Tools](/docs/guide/tools/) and [Skills](/docs/guide/skills/) for capability authoring, [Subagents](/docs/guide/subagents/) for delegated child sessions, [Sandboxes](/docs/guide/sandboxes/) for compute boundaries, and [Observability](/docs/guide/observability/) for operation and compaction events.

## Initialize a harness

Define an agent with `createAgent(...)`, then initialize it in a workflow with `init(createdAgent)`. The returned value is a harness; use `harness` as its variable name so code consistently reflects Flue's runtime model.

```ts title=".flue/workflows/review-document.ts"
import { createAgent, type FlueContext } from '@flue/runtime';

const reviewer = createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  instructions: 'Review documents for factual inconsistencies and missing evidence.',
}));

export async function run({ init, payload }: FlueContext<{ document: string }>) {
  const harness = await init(reviewer);
  const session = await harness.session();
  const response = await session.prompt(`Review this document:\n\n${payload.document}`);

  return { review: response.text };
}
```

A workflow invocation supplies the initialization context. In a workflow, the `id` received by a `createAgent(({ id, payload, env }) => ...)` initializer is that workflow's `runId`, and the initializer receives the workflow payload and target environment bindings.

An addressable agent module is initialized differently: when direct HTTP/WebSocket input or dispatched input targets an agent instance, Flue initializes the created agent for that stable instance id and opens the requested session in the default harness. These inputs advance persistent agent sessions; they are **not** workflow runs. See [Workflows](/docs/guide/workflows/) and [Observability](/docs/guide/observability/) for the lifecycle distinction.

```text
workflow invocation { runId }
  └─ harness = await init(createdAgent)
       └─ session operation, observed inside that workflow run

agent instance { id }
  └─ default harness initialized for direct or dispatched input
       └─ session operation, associated with the instance rather than a run
```

### Configure runtime capabilities on the created agent

Configuration that constructs the environment belongs on the created agent. For example, `cwd`, `sandbox`, and `persist` are returned from `createAgent(...)`, not supplied when the workflow initializes it:

```ts title=".flue/workflows/analyze-workspace.ts"
import { createAgent, type FlueContext } from '@flue/runtime';
import { local } from '@flue/runtime/node';

const analyst = createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  instructions: 'Inspect the workspace before answering.',
  sandbox: local(),
  cwd: '/srv/projects/example',
}));

export async function run({ init }: FlueContext) {
  const harness = await init(analyst);
  const session = await harness.session();

  return session.prompt('Identify the modules affected by the requested change.');
}
```

The `local()` example intentionally gives a Node-target agent host filesystem and shell access. For an isolated or platform-specific environment, choose a suitable sandbox instead; see [Sandboxes](/docs/guide/sandboxes/).

### Name or augment a harness during workflow initialization

`init(agent)` creates a harness named `"default"`. A workflow can assign another harness name, or add tools, skills, and subagent profiles for this initialized environment:

```ts title=".flue/workflows/compare.ts"
import { createAgent, type FlueContext } from '@flue/runtime';
import { policyTools } from '../shared/policy-tools.ts';
import { auditSkills } from '../shared/audit-skills.ts';
import { reviewerProfiles } from '../shared/reviewer-profiles.ts';

const analyst = createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
}));

export async function run({ init }: FlueContext) {
  const harness = await init(analyst, {
    name: 'audit',
    tools: policyTools,
    skills: auditSkills,
    subagents: reviewerProfiles,
  });
  const session = await harness.session();

  return session.prompt('Assess the proposed policy change.');
}
```

| `init(agent, options)` field | Effect |
| --- | --- |
| `name` | Selects this harness's identity within the current initialization context. Defaults to `"default"`. |
| `tools` | Adds application-defined tools to those configured by the created agent or its profile. |
| `skills` | Adds registered skills to those configured by the created agent or its profile. |
| `subagents` | Adds named profiles that a task may select. |

`init(...)` does **not** accept `cwd`, `sandbox`, or persistence configuration. Those options determine the environment and state boundary, so put them in `createAgent(...)`. Within one request or workflow invocation, each harness name may be initialized once; assign distinct names when initializing separate environments.

## Open sessions for conversation state

A harness contains one or more **sessions**. A session is the named conversation/state scope in which `prompt()`, `skill()`, `task()`, and `shell()` operations occur.

Call `harness.session()` for the default session, or pass a string to select a named thread:

```ts title=".flue/workflows/triage.ts"
import { createAgent, type FlueContext } from '@flue/runtime';

const triage = createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
}));

export async function run({ init }: FlueContext) {
  const harness = await init(triage);
  const session = await harness.session();

  await session.prompt('Read the issue and identify the likely component.');
  return session.prompt('Now propose a focused validation plan for that component.');
}
```

The second operation sees the conversation state retained by the same default session. To keep two threads distinct, name them:

```ts title=".flue/workflows/compare-reviews.ts"
import { createAgent, type FlueContext } from '@flue/runtime';

const reviewer = createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
}));

export async function run({ init }: FlueContext) {
  const harness = await init(reviewer);
  const security = await harness.session('security');
  const maintainability = await harness.session('maintainability');

  const [securityResult, maintainabilityResult] = await Promise.all([
    security.prompt('Review the change for security risks.'),
    maintainability.prompt('Review the change for maintenance risks.'),
  ]);

  return {
    security: securityResult.text,
    maintainability: maintainabilityResult.text,
  };
}
```

### Understand session identity

Both harnesses and sessions default to `"default"`. Stored conversation identity is separated by:

```text
agent instance or workflow invocation identity × harness name × session name
```

This means:

- `await harness.session()` and `await harness.session('default')` refer to the same session in that harness;
- sessions with different names have separate histories even when they use the same files and sandbox environment;
- identically named sessions in differently named harnesses do not share history; and
- an addressable agent's stable instance id can reopen stored session state on later input, subject to the selected persistence store.

A workflow receives a new invocation identity for each run. Named sessions are therefore most commonly useful inside that one workflow's orchestration unless your application deliberately supplies a storage and identity strategy suited to another pattern. Use an addressable agent when continuing session identity is the primary application requirement.

### Get, create, or delete sessions explicitly

`harness.session(name?)` is a get-or-create convenience: it loads existing conversation state when present or creates an empty session otherwise. Use `harness.sessions` when your application must enforce lifecycle expectations:

| Method | Use it when… | Behavior |
| --- | --- | --- |
| `harness.session(name?)` | You want to continue the named thread or start it if absent. | Gets or creates; defaults to `"default"`. |
| `harness.sessions.get(name?)` | The operation must only continue an existing thread. | Throws if no stored session exists. |
| `harness.sessions.create(name?)` | The operation must begin a new thread and must not overwrite an old one. | Throws if the session already exists. |
| `harness.sessions.delete(name?)` | The conversation should be forgotten. | Deletes stored conversation state; missing sessions are ignored. |
| `session.delete()` | You already have the session object to remove. | Deletes that session's stored conversation state. |

Deleting a parent session also deletes the stored child task-session tree associated with it. It does not imply deletion of files in the sandbox or reversal of external effects.

### Run operations sequentially within one session

A session allows one active operation at a time. Operations include `prompt()`, `skill()`, `task()`, `shell()`, and `compact()`. This preserves a single unambiguous conversation branch: each operation can observe what the previous operation recorded.

Do not perform concurrent work on the same session:

```ts
const session = await harness.session();

const first = session.prompt('Investigate option A.');
const second = session.prompt('Investigate option B.');

await Promise.all([first, second]);
```

The overlapping operation fails because the session is already busy. Instead, use separate named sessions for independent branches, then combine their responses in application code or in a later synthesis session:

```ts
const optionA = await harness.session('option-a');
const optionB = await harness.session('option-b');

const [a, b] = await Promise.all([
  optionA.prompt('Investigate option A.'),
  optionB.prompt('Investigate option B.'),
]);

const synthesis = await harness.session('synthesis');
return synthesis.prompt(`Compare these findings:\n\nA:\n${a.text}\n\nB:\n${b.text}`);
```

For model-driven delegation that needs its own child-session history and specialist behavior, use [Subagents](/docs/guide/subagents/) rather than forcing parallel branches into one parent session.

## Choose state and persistence boundaries

A session's stored state is its conversation history: user and assistant messages, recorded shell exchanges, task-session relationships, and compaction checkpoints. When the session is reopened, Flue reconstructs the active context from that stored history.

The selected `SessionStore` controls durability of this conversation state:

| Configuration or target behavior | Conversation-state durability |
| --- | --- |
| Generated Node.js runtime with no `persist` override | In memory for the life of that server process. Restarts and independently scaled processes do not share it. |
| Generated Cloudflare runtime handling an agent or workflow through its Durable Object integration | Stored in Durable Object SQLite by default when Durable Object storage is available. |
| `persist` returned by `createAgent(...)` | Uses your `SessionStore` implementation for that created agent's sessions instead of the target default. |

Configure a custom conversation store on the created agent when the default does not match the application's session-lifetime requirements:

```ts title=".flue/agents/support.ts"
import { createAgent, type SessionStore } from '@flue/runtime';
import { supportSessionStore } from '../shared/support-session-store.ts';

const persist: SessionStore = supportSessionStore;

export default createAgent(({ id }) => ({
  model: 'anthropic/claude-sonnet-4-6',
  instructions: `Support the conversation associated with ${id}.`,
  persist,
}));
```

A `SessionStore` saves, loads, and deletes `SessionData` under Flue's session identity keys. Select an implementation with suitable consistency, retention, tenant isolation, and access controls for conversation content.

### Do not confuse conversation persistence with filesystem durability

The session store does not store the sandbox's working files. The sandbox or connector determines whether files survive another session, another harness initialization, a server restart, or a platform relocation.

| State you need to retain | Controlled by |
| --- | --- |
| Conversation messages and compaction summaries | The session store chosen by `persist` or by the target default. |
| Files read or written in the agent workspace | The configured sandbox and its filesystem or workspace storage. |
| Workflow run history and run event records | Workflow-run storage and observation surfaces, not the session store alone. |
| External changes made through tools or shell commands | The external system or filesystem changed by that capability. |

For example, a durable Cloudflare-backed session does not automatically make an unrelated ephemeral sandbox filesystem durable. Conversely, a durable external workspace does not preserve conversation state when a Node server uses only its default in-memory session store.

## Make instructions and workspace context available at initialization

When Flue initializes a harness, it constructs the system context for its sessions from the created agent and the sandbox working directory. Initialization combines:

1. the framework's headless-execution preamble;
2. `instructions` from the selected agent configuration or profile;
3. the contents of `<cwd>/AGENTS.md`, followed by `<cwd>/CLAUDE.md`, when present in the sandbox;
4. a catalog of workspace skills found under `<cwd>/.agents/skills/<name>/SKILL.md`;
5. the current working directory and, when readable, its initial directory listing.

Agent instructions precede discovered workspace guidance. Workspace skill metadata is discovered at initialization and advertised to the model; skill content is accessed when that skill is used. Read [Skills](/docs/guide/skills/) for creating and invoking skills.

### Configure the working directory on the agent

Set `cwd` in `createAgent(...)` to select the workspace root used for context discovery and relative file access:

```ts title=".flue/agents/repository-reviewer.ts"
import { createAgent } from '@flue/runtime';
import { local } from '@flue/runtime/node';

export default createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  sandbox: local(),
  cwd: '/srv/repositories/catalog-service',
  instructions: 'Follow workspace guidance and review only the requested change.',
}));
```

`cwd` is part of created-agent runtime setup, not an `init(...)` option. Its meaning is inside the selected sandbox: a host-backed Node sandbox can point at a host checkout, while an in-memory or remote sandbox must already contain, or be prepared with, the intended workspace at that path.

The `.flue/` directory used for authored agent and workflow source discovery is separate from runtime context discovery. An agent reads `AGENTS.md`, `CLAUDE.md`, and workspace skills only if those files exist in its sandbox under its configured `cwd`; it does not see repository files merely because they were part of the application build.

### Prepare guidance before initializing the consuming harness

Context discovery happens during `init(...)`. If application setup creates `AGENTS.md`, `CLAUDE.md`, or a workspace skill, complete that setup before initializing the harness that should consume it.

For a Node workflow deliberately using a host-backed temporary workspace:

```ts title=".flue/workflows/review-generated-workspace.ts"
import { mkdir, writeFile } from 'node:fs/promises';
import { createAgent, type FlueContext } from '@flue/runtime';
import { local } from '@flue/runtime/node';

const cwd = '/tmp/flue-review-workspace';

const reviewer = createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  sandbox: local(),
  cwd,
}));

export async function run({ init }: FlueContext) {
  await mkdir(cwd, { recursive: true });
  await writeFile(`${cwd}/AGENTS.md`, 'Review only TypeScript source and report affected tests.');
  await writeFile(`${cwd}/change-request.md`, 'Check the request-validation change.');

  const harness = await init(reviewer);
  const session = await harness.session();

  return session.prompt('Read change-request.md and carry out the review.');
}
```

If you instead call `harness.fs.writeFile('AGENTS.md', ...)` after `init(...)`, the file is available as a workspace file, but it was not part of that harness's initialization-time system context. In the same way, adding a new workspace skill after initialization does not add it to the already discovered skill catalog. Stage initialization context before `init(...)`, or initialize a new, appropriately named harness after setup.

## Stage files and execute shell work deliberately

The harness and each of its sessions use the same configured sandbox environment. Their filesystem and shell methods differ in whether work becomes part of a session's conversation.

| Surface | Appropriate use | Recorded in session conversation state? |
| --- | --- | --- |
| `harness.fs` | Stage input files or retrieve artifacts without choosing a conversation. | No. |
| `session.fs` | Perform application-owned filesystem plumbing while already holding a session. | No. |
| `harness.shell(command)` | Prepare or inspect the sandbox out of conversation, such as installing dependencies or generating input before a session prompt. | No. |
| `session.shell(command)` | Perform shell work that later model turns should know occurred and be able to reason about. | Yes, as a bash-tool-shaped exchange. |
| Model-called file or shell tools | Let the model decide which workspace action to take during an operation. | Yes, through the agent/tool transcript and events. |

`harness.fs` and `session.fs` expose the same filesystem methods: `readFile()`, `readFileBuffer()`, `writeFile()`, `stat()`, `readdir()`, `exists()`, `mkdir()`, and `rm()`. They are out-of-band application operations: writing a file does not automatically tell the model that the file exists. Prompt the model to read staged inputs when it needs them.

### Stage inputs out of conversation

Use `harness.fs` when application code supplies a controlled input artifact:

```ts title=".flue/workflows/summarize-artifact.ts"
import { createAgent, type FlueContext } from '@flue/runtime';

const summarizer = createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  cwd: '/workspace',
}));

export async function run({ init, payload }: FlueContext<{ report: string }>) {
  const harness = await init(summarizer);
  await harness.fs.writeFile('inputs/report.md', payload.report);

  const session = await harness.session();
  return session.prompt('Read inputs/report.md and summarize its principal findings.');
}
```

Paths supplied to `harness.fs` and `session.fs` may be absolute or relative. Relative paths are resolved against the agent's sandbox `cwd`; in the example, `inputs/report.md` resolves below `/workspace`. Use absolute paths when sharing a path across connector implementations whose default working directories may differ.

### Choose whether shell setup enters conversation history

The difference between the two shell surfaces is intentional:

```ts title=".flue/workflows/build-and-review.ts"
import { createAgent, type FlueContext } from '@flue/runtime';

const reviewer = createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  cwd: '/workspace',
}));

export async function run({ init }: FlueContext) {
  const harness = await init(reviewer);

  await harness.shell('mkdir -p artifacts');
  const session = await harness.session();
  await session.shell('npm test');

  return session.prompt('Use the recorded test result to recommend next steps.');
}
```

The `mkdir` setup is not part of a conversation. The test execution is recorded in the session, including its command and result, so a later prompt has that shell work in context. If you pass environment values to `session.shell(..., { env })`, conversation records identify the environment keys but not their values; nevertheless, expose secrets to any executable sandbox capability only when the task requires them.

File and shell methods depend on the configured sandbox capability. The default environment and many Linux-style sandboxes provide file and shell behavior; another connector can replace model-facing tools or decline ordinary command execution. Choose the sandbox for the work you intend to perform and review its capability boundary in [Sandboxes](/docs/guide/sandboxes/). Use [Tools](/docs/guide/tools/) when a narrower application-owned action is safer or more appropriate than general shell access.

## Compact long session context

As a session accumulates messages and tool output, its model context can approach the selected model's context window. **Compaction** summarizes older history while retaining recent context verbatim, then stores that summary in session history so future operations can continue with a shorter active context.

Compaction retains conversation continuity; it is not archival storage. Important details can be reduced to a summary, and summarization itself uses a model and contributes usage and cost. For workflows that require exact source material, keep authoritative files or records available in the sandbox or your application data source rather than relying only on old conversation text.

### Use the defaults first

With ordinary agent configuration, threshold-based compaction is enabled. It runs after an assistant response when reported context use exceeds:

```text
context window - reserved output headroom
```

The model-aware defaults are:

| Setting | Default behavior | Tradeoff |
| --- | --- | --- |
| `reserveTokens` | Up to `20_000` tokens, reduced when the model's declared maximum output is smaller; tiny context windows receive an additional safety clamp. | More reserve compacts sooner but leaves more room for the next output and recovery. |
| `keepRecentTokens` | `8_000` recent tokens retained without summarization. | More recent tokens preserve immediate detail but reduce the space recovered by compaction. |
| Summarization model | The session's active model. | Reuses existing quality/cost behavior unless explicitly overridden. |

If a provider registration omits context-window metadata or reports no usable context window, threshold-based detection cannot anticipate the limit. Overflow recovery still provides a fallback if the provider reports an overflow. Configure accurate model metadata when using custom providers; see [LLMs & Models](/docs/guide/models/).

### Tune automatic compaction on the agent or profile

Set `compaction` in `createAgent(...)` or in a reusable agent profile. Use a smaller retained tail for aggressively reducing a tool-heavy history, a larger reserved margin when large upcoming outputs are expected, or a distinct summarization model when its cost or context characteristics better suit checkpoint creation.

```ts title=".flue/agents/long-review.ts"
import { createAgent } from '@flue/runtime';

export default createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  compaction: {
    reserveTokens: 24_000,
    keepRecentTokens: 10_000,
    model: 'anthropic/claude-haiku-4-5',
  },
}));
```

`reserveTokens` and `keepRecentTokens` are non-negative integer token counts. The summarization model creates the checkpoint; it does not change the configured model for ordinary session prompts.

### Trigger compaction explicitly

Call `session.compact()` when your application wants a checkpoint before continuing, such as between phases of a long interaction or in response to a user-interface compact action:

```ts title=".flue/workflows/multi-phase-analysis.ts"
import { createAgent, type FlueContext } from '@flue/runtime';

const analyst = createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
}));

export async function run({ init }: FlueContext) {
  const harness = await init(analyst);
  const session = await harness.session();

  await session.prompt('Inspect the evidence and record significant facts.');
  await session.compact();
  return session.prompt('Using the retained checkpoint, propose the final recommendation.');
}
```

`session.compact()` is a no-op when there is no valid older context to summarize. It is itself an exclusive session operation: do not run it while a prompt, skill, task, or shell operation is in flight on that session.

### Disable proactive threshold compaction carefully

Set `compaction: false` only when you deliberately do not want threshold-based automatic summarization:

```ts
const exactTranscriptAgent = createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  compaction: false,
}));
```

This setting has two important limits:

- it disables **threshold-triggered** compaction, not emergency overflow recovery; if a model operation overflows its context, Flue can still compact and retry so the session may continue;
- it does not disable `await session.compact()`; explicit manual compaction still uses the session model.

Consequently, `compaction: false` means “do not proactively summarize near the threshold,” not “the active conversation will always remain verbatim.” If an exact immutable transcript is required, retain it separately from model context and session compaction behavior.

### Observe compaction and account for its cost

Automatic and manual compaction use model calls to generate summaries. Their usage is included in the usage reported for the session operation that triggered automatic or overflow compaction, and compaction activity is emitted as observable events. Manual compaction emits its own operation and compaction events.

Useful observable event shapes include:

| Event | What it indicates |
| --- | --- |
| `compaction_start` | Compaction began, with reason `threshold`, `overflow`, or `manual`. |
| `turn_request` / `turn` with a compaction purpose | A summarization model call used to create or update the checkpoint. |
| `compaction` | A completed checkpoint, including before/after message counts and summarization usage when reported. |

See [Observability](/docs/guide/observability/) for receiving events, handling sensitive model/tool content, and relating session operations to a workflow run or addressable agent instance.

## Next steps

- Use [Prompting](/docs/guide/prompting/) to obtain text or structured results from a session operation.
- Add bounded executable capabilities with [Tools](/docs/guide/tools/) or reusable instructions with [Skills](/docs/guide/skills/).
- Use [Subagents](/docs/guide/subagents/) for delegated work that needs a child conversation scope.
- Select a workspace and execution boundary in [Sandboxes](/docs/guide/sandboxes/).
- Instrument session operations and compaction through [Observability](/docs/guide/observability/).
