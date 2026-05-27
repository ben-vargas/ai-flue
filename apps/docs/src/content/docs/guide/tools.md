---
title: Tools
description: Give agents executable capabilities through built-in tools, custom tools, and MCP servers.
---

Tools are executable capabilities that a model can decide to call during an operation. A tool has a name, a description visible to the model, a parameter schema, and an implementation that performs application-controlled work and returns information to the model.

Use tools when an agent must read data, change state, search a workspace, run a command, call an application service, or delegate focused work. Keep the capability narrow: expose the action the agent needs, not an unrestricted credential or an unvalidated destination.

A [skill](/docs/guide/skills/) is different. A skill packages reusable instructions and supporting resources that guide agent behavior; a tool executes code. A skill operation can use tools, but loading instructions alone does not grant a new external side effect.

| Need | Prefer |
| --- | --- |
| Tell an agent how to perform a repeatable procedure | A skill |
| Let an agent retrieve application data or perform an action | A custom tool |
| Let an agent work with files or commands inside its selected environment | Built-in sandbox tools |
| Expose capabilities already provided by a remote MCP service | MCP tools |

## Define a custom tool

Use `defineTool(...)` with `Type` to describe model-callable parameters. This example exposes one read-only application lookup and validates the identifier again at the execution boundary:

```ts title=".flue/workflows/order-status.ts"
import { Type, createAgent, defineTool, type FlueContext } from '@flue/runtime';

const orderStatusById = new Map([
  ['order_1042', 'packed'],
  ['order_1043', 'shipped'],
]);

const lookupOrderStatus = defineTool({
  name: 'lookup_order_status',
  description: 'Look up the current fulfillment status for one order ID.',
  parameters: Type.Object({
    orderId: Type.String({ description: 'Order ID in the form order_1234' }),
  }),
  execute: async ({ orderId }) => {
    if (typeof orderId !== 'string' || !/^order_[0-9]+$/.test(orderId)) {
      throw new Error('A valid order ID is required.');
    }

    const status = orderStatusById.get(orderId);
    return status ? `${orderId}: ${status}` : `${orderId}: not found`;
  },
});

const agent = createAgent(() => ({
  model: 'anthropic/claude-haiku-4-5',
  tools: [lookupOrderStatus],
}));

export async function run({ init, payload }: FlueContext<{ orderId: string }>) {
  const harness = await init(agent);
  const session = await harness.session();
  const response = await session.prompt(`Report the status of ${payload.orderId}.`);
  return { message: response.text };
}
```

A custom tool definition contains four fields:

| Field | Purpose |
| --- | --- |
| `name` | Identifier the model calls. Choose an action-oriented, stable, unique name. |
| `description` | Model-facing guidance about when to call the tool and what it does. |
| `parameters` | JSON Schema-compatible parameter shape. For authored tools, build it with `Type` from `@flue/runtime`. |
| `execute(args, signal?)` | Application code that performs the capability and resolves to a string returned to the model. |

`defineTool(...)` validates the definition itself: it requires a non-empty `name`, a non-empty `description`, an object-valued `parameters` field, and an `execute` function. It returns a shallow-frozen copy of the tool definition.

`Type.Object(...)` defines the parameter contract presented for tool calling. Do not treat it as your authorization or trust boundary: custom tool execution receives the tool arguments as a record. Validate values that select protected data or side effects in `execute(...)`, and make authorization decisions in trusted TypeScript code rather than in the prompt.

Before invoking a custom handler, Flue observes an already-aborted operation signal. It passes the optional `AbortSignal` to `execute(...)` so an implementation that performs cancellable work can forward it. A resolved string is returned to the model as the tool result; a thrown error is reported as a tool error the agent may be able to handle in a later turn.

### Keep permissions inside the handler

A model should request an allowed operation, not supply unrestricted credentials or arbitrary tenant ownership. Close over verified application context when defining a tool:

```ts title=".flue/workflows/customer-orders.ts"
import { Type, createAgent, defineTool, type FlueContext } from '@flue/runtime';

type Env = {
  ORDERS: {
    getStatus(customerId: string, orderId: string): Promise<string | null>;
  };
};

const agent = createAgent(() => ({ model: 'anthropic/claude-haiku-4-5' }));

export async function run({ init, payload, env }: FlueContext<{ customerId: string; question: string }, Env>) {
  const lookupCustomerOrder = defineTool({
    name: 'lookup_customer_order',
    description: 'Look up one order belonging to the authenticated customer.',
    parameters: Type.Object({
      orderId: Type.String({ description: 'Order ID supplied by the customer' }),
    }),
    execute: async ({ orderId }) => {
      if (typeof orderId !== 'string') throw new Error('An order ID is required.');
      const status = await env.ORDERS.getStatus(payload.customerId, orderId);
      return status ?? 'No accessible order was found.';
    },
  });

  const harness = await init(agent, { tools: [lookupCustomerOrder] });
  const session = await harness.session();
  return session.prompt(payload.question);
}
```

Here the model can choose an order ID to inspect, but cannot choose the customer boundary used in the lookup.

## Choose a tool scope

A tool becomes available wherever you attach its `ToolDefinition`. Choose the smallest scope that reliably supports the operation.

| Scope | Attach with | Available for | Use when |
| --- | --- | --- | --- |
| Reusable profile | `defineAgentProfile({ tools: [...] })` | Created agents or declared subagents that use that profile | Several agents share the same capability set. |
| Created agent | `createAgent(() => ({ tools: [...] }))` | Sessions initialized from that created agent | The capability belongs to that agent's role or instance. |
| Initialized harness | `init(agent, { tools: [...] })` | Sessions in that initialized harness | A workflow establishes capability or authorization context at initialization time. |
| One operation | `session.prompt(..., { tools: [...] })`, `session.skill(..., { tools: [...] })`, or `session.task(..., { tools: [...] })` | Only that operation | The capability is needed only for one bounded action. |

Scopes add capabilities; they do not override a tool with the same name. If a broad and a narrower scope both supply `lookup_order_status`, initialization or the affected operation fails with a duplicate-tool error. Name each distinct capability distinctly, or place it at only one scope.

### Reuse capabilities with a profile

A profile is appropriate when a capability is part of a reusable agent role, including a role used as a subagent:

```ts title=".flue/agents/support.ts"
import { Type, createAgent, defineAgentProfile, defineTool } from '@flue/runtime';

const lookupPolicy = defineTool({
  name: 'lookup_policy',
  description: 'Find an approved support policy by topic.',
  parameters: Type.Object({ topic: Type.String() }),
  execute: async ({ topic }) => `Policy search requested for: ${String(topic)}`,
});

const supportProfile = defineAgentProfile({
  instructions: 'Use approved policy material when answering support questions.',
  tools: [lookupPolicy],
});

export default createAgent(() => ({
  profile: supportProfile,
  model: 'anthropic/claude-haiku-4-5',
}));
```

### Add tools while initializing a harness

Use `init(..., { tools })` when a workflow creates the boundary that makes a tool valid, such as a verified account, an opened connection, or a resource selected for this invocation:

```ts title=".flue/workflows/review-account.ts"
const harness = await init(agent, { tools: [lookupCustomerOrder] });
const session = await harness.session('review');
const response = await session.prompt('Review accessible open orders.');
```

The addition applies throughout that initialized harness, including subsequent operations on its sessions.

### Expose a tool for one operation

Use an operation-local tool when granting it for later prompts would be unnecessary or too broad:

```ts title=".flue/workflows/review-account.ts"
const response = await session.prompt('Check whether this one order can be cancelled.', {
  tools: [checkCancellationEligibility],
});

await session.skill('compose-response', {
  tools: [lookupCustomerOrder],
});

await session.task('Check this order and produce a brief summary.', {
  tools: [lookupCustomerOrder],
});
```

`prompt(...)` and `skill(...)` use their temporary tools while completing that operation. `task(...)` provides its temporary tools to the delegated child work for that task. See [Subagents](/docs/guide/subagents/) for choosing child-agent profiles and task boundaries.

## Use built-in sandbox tools

By default, a model-driven operation receives tools backed by its active sandbox environment. Their reach is determined by the sandbox, not by the model or the tool name: a lightweight in-process workspace, a deliberate local environment, and a remote connector have different filesystem and command boundaries.

| Default model-facing tool | Capability in the active sandbox environment |
| --- | --- |
| `read` | Read a file or list a directory. |
| `write` | Write a file, creating parent directories where needed. |
| `edit` | Replace exact text in an existing file. |
| `bash` | Execute a command through the sandbox environment. |
| `grep` | Search file contents. |
| `glob` | Search for files by name pattern. |
| `task` | Delegate focused model work to a child session. |

The framework owns `task`: it is available for model delegation independently of which workspace tool surface the sandbox supplies. See [Subagents](/docs/guide/subagents/) to configure named delegated roles and [Sandboxes](/docs/guide/sandboxes/) before relying on filesystem or command behavior.

### Account for sandbox connectors

A sandbox connector can provide its own model-facing tool factory. When it does, that returned tool list replaces the default workspace tool list (`read`, `write`, `edit`, `bash`, `grep`, and `glob`) for that sandbox. Flue still appends its framework-owned `task` tool.

Consequently, application prompts should not promise that a remote agent can use `bash` or `read` unless its selected connector actually exposes those tools. A connector that supplies `read` may also be adapted by Flue when packaged skill resources must be readable during a skill operation.

## Avoid name collisions

Tool names share one model-visible namespace during an operation. Flue rejects ambiguous capability sets rather than choosing one implementation silently.

| Source | Collision behavior |
| --- | --- |
| Default sandbox tools | Custom tools cannot be named `read`, `write`, `edit`, `bash`, `grep`, `glob`, or `task` while the default tool set is active. |
| Connector-provided tools | A connector must return unique names and cannot return `task`; custom tools cannot collide with any active connector tool. |
| Framework delegation | `task` remains framework-reserved even if a connector replaces the default workspace tools. |
| Custom scopes | Duplicate custom names assembled from profile, created agent, `init()`, or operation options are rejected. |
| MCP connection | MCP tools are exposed with prefixed names such as `mcp__inventory__lookup_item`; names that become duplicates after sanitizing are rejected within that connection, and they must still not collide with other active tools. |

Choose descriptive application names such as `lookup_customer_order` or `create_support_ticket`, rather than reusing generic built-in names.

## Understand tool calls, history, and events

A model-called tool is part of the conversation, not invisible application plumbing. When the model calls a custom, built-in, or MCP-provided tool, its tool call and returned tool result become session context for subsequent turns. This is how the model can use the result to finish its answer.

Tool activity is also observable:

| Events | Meaning |
| --- | --- |
| `tool_execution_start`, `tool_execution_update`, `tool_execution_end` | Agent-loop tool execution progress, including arguments and results where emitted. |
| `tool_start`, `tool_call` | Normalized start and completed span for tool tracing and timing. |

If a workflow performs the operation, its tool activity is nested within that workflow run history. Direct or dispatched persistent-agent interactions expose operation and observation events, but do not create workflow runs. See [Observability](/docs/guide/observability/) for event correlation and telemetry export.

Treat tool inputs and results as potentially sensitive. A tool result is returned to the model and may appear in conversation history and events. Keep credentials in trusted application code, return only the data the model needs, and redact or filter observability exports as appropriate. For application plumbing that should not automatically enter model history, use the harness or session filesystem surface described in [Sandboxes](/docs/guide/sandboxes/).

## Connect MCP tools

Use `connectMcpServer(...)` to connect to a remote MCP server from trusted application code. It lists that server's tools and returns them as ordinary `ToolDefinition` values, which you can attach through the same created-agent, `init()`, or operation-local scopes as authored custom tools.

```ts title=".flue/workflows/inventory-assistant.ts"
import { connectMcpServer, createAgent, type FlueContext } from '@flue/runtime';

type Env = {
  INVENTORY_MCP_URL: string;
  INVENTORY_MCP_TOKEN: string;
};

const agent = createAgent(() => ({
  model: 'anthropic/claude-haiku-4-5',
}));

export async function run({ init, payload, env }: FlueContext<{ question: string }, Env>) {
  const inventory = await connectMcpServer('inventory', {
    url: env.INVENTORY_MCP_URL,
    headers: {
      Authorization: `Bearer ${env.INVENTORY_MCP_TOKEN}`,
    },
  });

  try {
    const harness = await init(agent, { tools: inventory.tools });
    const session = await harness.session();
    return await session.prompt(payload.question);
  } finally {
    await inventory.close();
  }
}
```

The connection name contributes to model-visible tool names: for example, an MCP tool named `lookup_item` from the `inventory` connection is exposed as `mcp__inventory__lookup_item`. The prefix makes a tool's source clearer and reduces accidental clashes; the ordinary collision rules still apply when you compose capabilities.

### Choose the MCP transport explicitly when needed

`connectMcpServer(...)` supports remote HTTP transports:

| Configuration | Transport |
| --- | --- |
| Omit `transport` | Modern streamable HTTP, the default. |
| `transport: 'streamable-http'` | Modern streamable HTTP, selected explicitly. |
| `transport: 'sse'` | Legacy SSE MCP server transport. |

```ts title="Connect to a legacy SSE MCP server"
const catalog = await connectMcpServer('catalog', {
  url: env.CATALOG_MCP_URL,
  transport: 'sse',
  headers: {
    Authorization: `Bearer ${env.CATALOG_MCP_TOKEN}`,
  },
});
```

Provide authorization headers and any policy-relevant connection settings in trusted application code. Do not place tokens in prompts, sandbox files, or model-selected tool arguments. Close each MCP connection when the scope that uses its tools finishes, including failure paths.

Flue's MCP adapter does not auto-detect transports, start local stdio MCP processes, or implement OAuth callback handling. Establish any required authorization before connecting, then provide the resulting headers or request configuration to `connectMcpServer(...)`.

## Recommended progression

| If you are building... | Start with... | Add when needed... |
| --- | --- | --- |
| An agent answering from workspace files | Default built-in tools in an appropriately bounded sandbox | Custom tools for protected application data or side effects. |
| An application assistant that can perform one action | A narrowly scoped custom tool attached at the operation or harness boundary | Profile or created-agent scope once the action is routinely required. |
| A specialist reused in several places | A profile with stable capability names | Operation-local tools for request-specific access only. |
| An agent using a remote capability provider | `connectMcpServer(...)` in trusted code and guaranteed connection cleanup | Multiple MCP connections only after checking tool-name and authorization boundaries. |

Continue with [Skills](/docs/guide/skills/) for instruction-driven capabilities, [Subagents](/docs/guide/subagents/) for delegated work, [Sandboxes](/docs/guide/sandboxes/) for execution boundaries, [Prompting](/docs/guide/prompting/) for operation options and results, and [Observability](/docs/guide/observability/) for tool event handling.
