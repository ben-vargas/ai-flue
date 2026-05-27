---
title: Why Flue?
description: Build programmable agents with explicit runtime capabilities and deployment surfaces.
---

**Flue** is a TypeScript framework for building agents as deployable applications, with an **agent harness** for sessions, tools, workspace context, and sandboxed execution. It is for applications where a model must do more than produce one response: it must operate within an environment that your code defines and controls.

A Flue project can expose a continuing, addressable agent for conversations and events, define a bounded workflow that returns a result, or combine both in one application. Flue does not erase the architectural choices behind those experiences: your application chooses the runtime capabilities, interaction surface, persistence strategy, and deployment target.

Flue is experimental and its APIs may change. This makes its design model especially important when deciding whether it fits your application.

## Design principles

Five ideas explain the problems Flue is designed to solve and the architecture it provides:

1. **[Agents need an environment](#agents-need-an-environment):** Useful agents combine a model with sessions, context, tools, and a place to do work.
2. **[Orchestration is application code](#orchestration-is-application-code):** TypeScript decides how agents are initialized, prompted, composed, and connected to your system.
3. **[Conversations and jobs are different](#conversations-and-jobs-are-different):** Persistent agent interactions and finite workflow runs are separate runtime concepts.
4. **[Capabilities are deliberate](#capabilities-are-deliberate):** Tools, sandboxes, routes, credentials, and persistence belong to explicit application boundaries.
5. **[Deployment is target-aware](#deployment-is-target-aware):** The same authored model can build for Node.js or Cloudflare while platform behavior remains visible.

## Agents need an environment

**An agent is useful when it can operate in a deliberately constructed environment, not only receive a prompt.** A customer-support assistant may need a knowledge workspace and an ongoing thread. A coding agent may need files, shell execution, and tools. An automation agent may need structured output so application code can make the next decision.

Flue calls that initialized environment a **harness**. A created agent declares behavior and runtime choices with `createAgent(...)`: its model, instructions, tools, skills, working directory, sandbox, persistence configuration, and reusable profiles where applicable. When a workflow calls `init(agent)`, or when an addressable agent receives input, Flue initializes that created agent into a harness. The harness provides:

- **Sessions**, which hold named conversational context for operations such as prompting or invoking a skill.
- **Filesystem and execution surfaces**, backed by the selected sandbox, for staging context or performing work.
- **Tools and skills**, which determine actions and specialized instructions available to agent operations.
- **Runtime-discovered context**, including `AGENTS.md`, `CLAUDE.md`, and workspace skills in the configured working directory when those files exist.

Inside a harness, a **session** is a conversation scope. A `session.prompt(...)` call is an **operation**, and one operation can require multiple model turns and tool calls before it produces an answer. This hierarchy matters: a useful agent can continue context across more than one request, while each individual operation still has a clear boundary.

This approach makes an agent more than a provider call wrapped in an endpoint. The model operates in the context of a TypeScript application that can prepare files, supply bounded tools, validate results, separate conversation threads, and select the compute environment required by the work.

For example, a lightweight knowledge assistant can use Flue's default virtual sandbox and have application code write a small set of articles before prompting. A coding assistant can instead use a sandbox implementation that provides a real project environment and command-line tooling. These are different application needs; Flue gives them the same harness-and-session programming model without pretending they require the same runtime capability.

Read [Agents](/docs/concepts/agents/) for addressable agent behavior and [Getting Started](/docs/getting-started/quickstart/) for the smallest workflow that initializes a harness and opens a session.

## Orchestration is application code

**Flue keeps the control flow around agent work in TypeScript.** Prompts and skills can describe what an agent should do, but application code remains responsible for when it runs, what input it sees, which capabilities it receives, and what happens with its result.

A Flue **workflow** is a TypeScript module exporting `run(...)`. Its context supplies the invocation payload, runtime environment, structured logging, and `init(...)`. Within that finite invocation, a workflow can initialize an agent, open one or more sessions, perform operations, inspect structured results, and return an application-facing value.

This is useful for work with a bounded outcome, such as:

- translating or extracting structured information from input;
- triaging an issue and returning a typed classification;
- preparing files before an agent reads them;
- coordinating several isolated harness or session scopes in one job;
- performing automation that your application needs to observe as one invocation.

The same separation applies to persistent agents. An agent module under `agents/` default-exports a created agent that can be reached by a stable instance identifier. Application-owned routing or integration code can decide which event reaches which agent instance and session. The agent then handles accepted input using the environment it was configured to have.

This means orchestration does not have to be hidden inside a long prompt or delegated to an unstructured loop. It can be normal code: receive a payload, choose an agent, stage controlled context, call an operation, validate its result, or dispatch a new message into a continuing session. Markdown instructions and skills remain valuable for agent behavior; TypeScript owns application behavior.

Flue therefore fits architectures where the application needs to combine agent autonomy with conventional software decisions: authorization, data preparation, result validation, side-effect control, transport choice, and error handling. See [Workflows](/docs/guide/workflows/) for bounded orchestration and [Routing](/docs/guide/routing/) for the surfaces an application can expose.

## Conversations and jobs are different

**A continuing agent relationship is not the same thing as a finite job, and Flue models them separately.** This distinction avoids treating every chat turn or inbound event as a new run while still giving finite automation an inspectable execution record.

An **agent instance** is selected by a caller-defined `id` in an addressable agent route such as `/agents/<name>/<id>`. The identifier can represent the boundary your application needs: a conversation, customer, repository, or other stable scope. Direct agent input operates in the instance's default harness and can select named sessions to separate conversational threads. Workflow orchestration can additionally initialize named harnesses when it needs separate environments within one run.

Direct agent interactions can arrive through HTTP or a WebSocket connection. An application can also call `dispatch(...)` to accept asynchronous input for a target agent instance and session, for example after normalizing an inbound integration event. These interactions advance agent sessions:

- A direct prompt is an attached interaction: the caller observes its response or stream while that operation completes.
- A dispatched input is asynchronous delivery: acceptance returns a `dispatchId`, and processing occurs in the target session.
- Both are session operations associated with an agent instance; neither is a workflow run.

A **workflow invocation**, by contrast, is finite and receives a `runId`. Whether the invoking caller waits for the returned result, observes streamed events, accepts a background admission response, or uses a workflow WebSocket, it is still one workflow run. Workflow runs are the records exposed through run inspection APIs and workflow logging surfaces.

| You need to model…                                                       | Use…                              | Identity and observation model                                   |
| ------------------------------------------------------------------------ | --------------------------------- | ---------------------------------------------------------------- |
| A conversational assistant reached repeatedly by the same user or thread | An addressable agent              | Stable instance `id` and session; operations are not runs.       |
| Event-driven input delivered into ongoing agent context                  | `dispatch(...)` to an agent       | `dispatchId` plus instance/session identity; not a workflow run. |
| A bounded task with a result and inspectable execution                   | A workflow                        | One finite invocation with a `runId`.                            |
| A workflow that asks an agent to perform part of its job                 | A workflow initializing a harness | The agent operations are nested work within that workflow run.   |

This is also a persistence distinction. Sessions are the continuing context of an agent harness, but how long that state survives depends on the target and configuration. On Node.js, the default session store is in memory for the process lifetime unless your application provides a store. On Cloudflare, generated agent handling uses Durable Object-backed session storage. Filesystems, external effects, and custom sandboxes have their own persistence semantics and should not be assumed durable merely because a session is durable.

Choose the identity that matches the user experience: a stable agent instance and session for ongoing interaction; a workflow run for an execution you expect to finish and inspect as one job. See [Workflows](/docs/guide/workflows/) and [Routing](/docs/guide/routing/) for the invocation surfaces behind this distinction.

## Capabilities are deliberate

**Agent capability should be an application decision, because agent work can read data, execute code, and cause effects.** Flue provides capability surfaces, but it does not require every agent to receive every capability.

These capabilities have explicit configuration boundaries:

- **Created agents** configure model behavior, instructions, skills, tools, subagents, the sandbox, working directory, and an optional session store.
- **Workflow initialization** can name a harness and add tools, skills, or subagents for that initialized environment.
- **Tools** expose application-controlled actions with defined parameters and implementation code.
- **Sandboxes and working directories** determine the filesystem, execution environment, and runtime workspace context available to a harness.
- **Route middleware and application composition** determine whether and how agent or workflow surfaces are exposed to callers.

The default sandbox is a lightweight virtual environment suitable for agents that need basic filesystem or shell-backed work without access to the host operating system. It is an effective starting point for prompt-and-response agents or contexts staged by your application. When an agent genuinely needs host access on Node.js, the `local()` sandbox makes that boundary deliberate: it operates on the host filesystem and shell, and additional environment values such as credentials must be intentionally provided. When it needs a different isolated or platform-specific workspace, a sandbox adapter or connector can supply that environment instead.

Tools create a narrower boundary for effects that do not require general shell access. A tool can, for example, look up an approved record or post a reply to an already validated destination while keeping the underlying credential and authorization decision in trusted application code. Conversely, giving an agent a host shell or a remote full Linux sandbox is appropriate only when the task truly requires those capabilities and the surrounding isolation is appropriate.

Routing is part of the same design. Flue can expose agents and workflows through routes when their modules opt in with middleware, and a custom application entrypoint can compose those routes with authentication and integration endpoints. A stable agent `id` is powerful precisely because it selects an ongoing scope; applications should authorize access to that scope rather than expose arbitrary identities accidentally.

Persistence is also explicit rather than universal. The conversation data kept by a session, files in a sandbox, delivery durability, external side effects, and workflow-run history are related concerns, but they are not interchangeable. Selecting a target or custom store solves only the persistence concern that target or store actually implements. This keeps architecture decisions visible when building production assistants, automation, or coding environments.

Learn more in [Sandboxes](/docs/guide/sandboxes/) and [Routing](/docs/guide/routing/).

## Deployment is target-aware

**Flue separates the authored agent-and-workflow model from target-specific server integration.** Today, Flue's build tooling supports two deployment targets: **Node.js** and **Cloudflare**.

The CLI discovers authored `agents/` and `workflows/` modules from either the project root or the `.flue/` source layout and builds a deployable server artifact for the selected target. Across both targets, applications can use the same central concepts: created agents, harness initialization, named sessions, workflow runs, direct agent interactions, tools, and sandbox configuration.

The targets are not presented as identical execution environments:

| Target     | What it provides                                                                                | Architectural considerations                                                                                                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node.js    | A generated Node server for conventional hosting and local development.                         | Sessions and run records are in process memory by default; configure persistence when state must survive restart or scale-out. Node can intentionally grant host filesystem and shell access with `local()`. |
| Cloudflare | A Workers-compatible application using target integration for addressable agents and workflows. | Agent session storage is backed by Durable Objects in the generated runtime, and platform bindings or Cloudflare-specific sandbox choices can be used where configured.                                      |

This target-aware model lets you keep agent logic recognizable while still making platform choices explicit. A simple workflow can use the virtual sandbox on either target. A Node-based CI agent can intentionally run within a trusted runner boundary. A Cloudflare application can use platform bindings and Durable Object-backed agent sessions. If your application depends on target-specific storage, sandbox, binding, or interruption semantics, that dependency should remain part of its design rather than be hidden behind a portability promise.

Flue is a fit when you want a TypeScript application architecture for agents: runtime environments instead of bare prompts, code-owned orchestration, a clear division between continuing sessions and finite jobs, and deliberate deployment and capability choices. If you only need an isolated model request with no continuing context, tool environment, routing model, or observable workflow execution, a full harness framework may be more than your application needs.

Start with [Getting Started](/docs/getting-started/quickstart/), then choose a deployment path in [Deploy Agents on Node.js](/docs/deploy/node/) or [Deploy Agents on Cloudflare](/docs/deploy/cloudflare/).
