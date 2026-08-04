---
{
  "kind": "sandbox",
  "version": 1,
  "website": "https://daytona.io",
  "aliases": ["@daytona/sdk"]
}
---

# Add a Flue Sandbox Adapter: Daytona

You are an AI coding agent installing the Daytona sandbox adapter for a
Flue project. Follow these instructions exactly. Confirm with the user only
when something is genuinely ambiguous (e.g. an unusual project layout).

## What this adapter does

Wraps an already-initialized Daytona sandbox (created with the user's own
`@daytona/sdk` client) into Flue's `SandboxFactory` interface. The user owns
the Daytona client lifecycle; this adapter just adapts the sandbox.

## Where to write the file

Select the first existing source directory: `<root>/.flue/`, then `<root>/src/`,
then `<root>/`. Write the adapter to `<source-dir>/sandboxes/daytona.ts`.

If neither feels right (uncommon layout, multiple workspaces, etc.), ask the
user before writing.

Create any missing parent directories.

## File contents

Write this file verbatim. Do not "improve" it — it conforms to the published
`SandboxDriver` contract.

```ts
// flue-blueprint: sandbox/daytona@1
/**
 * Daytona adapter for Flue.
 *
 * Wraps an already-initialized Daytona sandbox into Flue's SandboxFactory
 * interface. The user creates and configures the sandbox using the Daytona
 * SDK directly — Flue just adapts it.
 *
 * @example
 * ```typescript
 * 'use agent';
 * import { Daytona } from '@daytona/sdk';
 * import { useModel, useSandbox } from '@flue/runtime';
 * import { daytona } from './sandboxes/daytona';
 *
 * export function Assistant() {
 *   useModel('anthropic/claude-sonnet-4-6');
 *   useSandbox({
 *     // Lazy, per the SandboxFactory contract: constructing this object is
 *     // cheap; the expensive Daytona sandbox creation happens once, inside
 *     // createSandbox(), at initialization — never on a re-render.
 *     async createSandbox(options) {
 *       const client = new Daytona({ apiKey: process.env.DAYTONA_API_KEY });
 *       const sandbox = await client.create({ image: 'ubuntu:latest' });
 *       return daytona(sandbox).createSandbox(options);
 *     },
 *   });
 *   return 'You are a helpful assistant with a full sandbox.';
 * }
 * ```
 */
import {
	sandboxFromDriver,
	SandboxDiedError,
	SandboxOperationUnsupportedError,
} from '@flue/runtime';
import type { SandboxDriver, SandboxFactory, Sandbox, FileStat } from '@flue/runtime';
import { DaytonaNotFoundError } from '@daytona/sdk';
import type { Sandbox as DaytonaSandbox } from '@daytona/sdk';

/** How often the death detector reads sandbox state while a call is pending. */
const STATE_POLL_MS = 5_000;
/** How long a state probe may go unanswered before the sandbox is presumed dead. */
const PROBE_SILENCE_MS = 10_000;

/**
 * Sandbox states that mean the sandbox is authoritatively gone. Everything
 * else — transitional states (`starting`, `stopping`, `destroying`, …),
 * `unknown`, `archived`, `paused`, a missing value, and any state added in
 * future SDK versions — counts as alive, so a legitimately slow command on
 * a healthy sandbox is never interrupted.
 */
const DEAD_STATES: ReadonlySet<string> = new Set([
	'destroyed',
	'stopped',
	'error',
	'build_failed',
]);

/**
 * Await a Daytona SDK call while watching for sandbox death. The Daytona SDK
 * routes control-plane and toolbox requests through one HTTP client whose
 * request timeout is 24 hours — effectively unbounded — so a call that is in
 * flight when the sandbox dies can hang an agent for hours. While the call
 * is pending, this polls `sandbox.refreshData()` (one control-plane GET) and
 * rejects with {@link SandboxDiedError} once `sandbox.state` reports a dead
 * state; a probe that itself goes unanswered for the silence bound means the
 * control plane is unreachable too, and the sandbox is presumed dead with it.
 *
 * There is deliberately no deadline: any state outside {@link DEAD_STATES}
 * counts as alive, and a rejecting probe is an answer, not death — a
 * transient control-plane error must not kill a healthy command. The one
 * exception is `DaytonaNotFoundError`: the control plane no longer knows the
 * sandbox, which the SDK itself maps to `destroyed`.
 *
 * Liveness only: this never races the caller's abort signal. Caller-facing
 * cancellation is owned one layer up, by `sandboxFromDriver`'s `exec`
 * abort race — it rejects promptly on abort and consumes this promise's
 * eventual settlement once the caller has already been released.
 */
function raceSandboxDeath<T>(
	sandbox: DaytonaSandbox,
	operation: string,
	call: Promise<T>,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		let pollTimer: ReturnType<typeof setTimeout> | undefined;
		let silenceTimer: ReturnType<typeof setTimeout> | undefined;

		const settle = (complete: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(pollTimer);
			clearTimeout(silenceTimer);
			complete();
		};

		const probe = (): void => {
			silenceTimer = setTimeout(() => {
				settle(() => reject(new SandboxDiedError({ operation, reason: 'probe_silent' })));
			}, PROBE_SILENCE_MS);
			sandbox.refreshData().then(
				() => {
					if (settled) return;
					clearTimeout(silenceTimer);
					const state = sandbox.state;
					if (state !== undefined && DEAD_STATES.has(state)) {
						settle(() => reject(new SandboxDiedError({ operation, reason: 'stopped' })));
					} else {
						pollTimer = setTimeout(probe, STATE_POLL_MS);
					}
				},
				(error: unknown) => {
					if (settled) return;
					clearTimeout(silenceTimer);
					if (error instanceof DaytonaNotFoundError) {
						settle(() => reject(new SandboxDiedError({ operation, reason: 'stopped' })));
					} else {
						// Any other rejecting probe is an answer, not silence — and
						// not proof of death. Keep polling.
						pollTimer = setTimeout(probe, STATE_POLL_MS);
					}
				},
			);
		};
		pollTimer = setTimeout(probe, STATE_POLL_MS);

		// These handlers double as the losing branch's rejection consumer, so a
		// late settlement after death or abort can't surface as an unhandled
		// rejection.
		call.then(
			(value) => settle(() => resolve(value)),
			(error: unknown) => settle(() => reject(error)),
		);
	});
}

/**
 * Implements SandboxDriver by wrapping Daytona's TypeScript SDK. Every SDK call
 * goes through the death detector so a call that is in flight when the
 * sandbox dies settles instead of hanging.
 */
class DaytonaSandboxDriver implements SandboxDriver {
	constructor(private sandbox: DaytonaSandbox) {}

	private guarded<T>(operation: string, call: Promise<T>): Promise<T> {
		return raceSandboxDeath(this.sandbox, operation, call);
	}

	async readFile(path: string): Promise<string> {
		const buffer = await this.guarded('readFile', this.sandbox.fs.downloadFile(path));
		return buffer.toString('utf-8');
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		const buffer = await this.guarded('readFile', this.sandbox.fs.downloadFile(path));
		return new Uint8Array(buffer);
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		const buffer =
			typeof content === 'string' ? Buffer.from(content, 'utf-8') : Buffer.from(content);
		await this.guarded('writeFile', this.sandbox.fs.uploadFile(buffer, path));
	}

	async stat(path: string): Promise<FileStat> {
		const info = await this.guarded('stat', this.sandbox.fs.getFileDetails(path));
		return {
			isFile: !info.isDir,
			isDirectory: info.isDir,
			size: info.size,
			mtime: new Date(info.modTime),
		};
	}

	async readdir(path: string): Promise<string[]> {
		const entries = await this.guarded('readdir', this.sandbox.fs.listFiles(path));
		return entries.map((e) => e.name).filter((name): name is string => !!name);
	}

	async exists(path: string): Promise<boolean> {
		try {
			await this.guarded('exists', this.sandbox.fs.getFileDetails(path));
			return true;
		} catch (error) {
			// Sandbox death is an infrastructure failure, not a missing path.
			if (error instanceof SandboxDiedError) throw error;
			return false;
		}
	}

	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		if (options?.recursive) {
			await this.exec(`mkdir -p '${path.replace(/'/g, "'\\''")}'`);
			return;
		}
		await this.guarded('mkdir', this.sandbox.fs.createFolder(path, '755'));
	}

	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		if (options?.force) {
			throw new SandboxOperationUnsupportedError({
				operation: 'rm',
				provider: 'Daytona',
				options: ['force'],
			});
		}
		await this.guarded('rm', this.sandbox.fs.deleteFile(path, options?.recursive));
	}

	async exec(
		command: string,
		options?: {
			cwd?: string;
			env?: Record<string, string>;
			timeoutMs?: number;
			signal?: AbortSignal;
		},
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		// Daytona's executeCommand does not accept an AbortSignal, so it is
		// deliberately not forwarded here — sandboxFromDriver (which
		// this adapter builds on) owns caller-facing abort and rejects
		// promptly while the sandbox keeps running the command.
		const response = await this.guarded(
			'exec',
			this.sandbox.process.executeCommand(
				command,
				options?.cwd,
				options?.env,
				typeof options?.timeoutMs === 'number'
					? Math.ceil(options.timeoutMs / 1000)
					: undefined,
			),
		);
		return {
			stdout: response.result ?? '',
			stderr: '',
			exitCode: response.exitCode ?? 0,
		};
	}
}

/**
 * Create a Flue sandbox factory from an initialized Daytona sandbox.
 * The user owns the sandbox lifecycle; Flue wraps it into a Sandbox
 * for agent use.
 */
export function daytona(sandbox: DaytonaSandbox): SandboxFactory {
	return {
		async createSandbox(): Promise<Sandbox> {
			const sandboxCwd =
				(await raceSandboxDeath(sandbox, 'getWorkDir', sandbox.getWorkDir())) ??
				'/home/daytona';
			const driver = new DaytonaSandboxDriver(sandbox);
			return sandboxFromDriver(driver, sandboxCwd);
		},
	};
}
```

## Required dependencies

This adapter imports from `@daytona/sdk`, so the user's project needs to
depend on it directly. If their `package.json` does not already list it,
add it:

```bash
npm install @daytona/sdk@^0.187.0
```

(Use the user's package manager — `pnpm add`, `yarn add`, etc. if their
lockfile indicates a different one.)

## Authentication

This adapter needs `DAYTONA_API_KEY` at runtime. **Never invent a value
for it** — it must come from the user.

Use your judgment for where it should live. The project's conventions, an
`AGENTS.md`, or an existing setup (`.env`, `.dev.vars`, a secret manager,
CI vars, etc.) will usually tell you the right answer. If nothing in the
project gives you a clear signal, ask the user instead of guessing.

For reference: `flue run` loads the project's `.env` by default, and
`--env <file>` selects one alternate `.env`-format file. `vite dev` and the
built server read the shell environment (`process.env`).

## Wiring it into an agent

Here's what using this adapter looks like inside a Flue agent. If the
user is already working on an agent that this adapter is meant to plug
into, you can finish that work by wiring the adapter into it. Otherwise,
share this snippet so they can wire it up themselves.

```ts
'use agent';
import { Daytona } from '@daytona/sdk';
import { useModel, useSandbox } from '@flue/runtime';
import { daytona } from '../sandboxes/daytona'; // adjust path to match the user's layout

export function Assistant() {
	useModel('anthropic/claude-sonnet-4-6');
	useSandbox({
		// Lazy, per the SandboxFactory contract: constructing this object is
		// cheap; the expensive Daytona sandbox creation happens once, inside
		// createSandbox(), at initialization — never on a re-render.
		async createSandbox(options) {
			const client = new Daytona({ apiKey: process.env.DAYTONA_API_KEY });
			const sandbox = await client.create();
			return daytona(sandbox).createSandbox(options);
		},
	});
	return 'You are a helpful assistant with a full sandbox.';
}
```

The `'use agent'` directive at the top is what registers the module with
the application. Mount `createAgentRouter(...)` (from `@flue/runtime/routing`) in
`app.ts` only if the agent needs
an HTTP endpoint — `flue run` and `dispatch()` work without a mount.

## Verify

1. Run the user's typechecker (`npx tsc --noEmit` is a safe default) and
   confirm the new file has no errors.
2. Confirm the import path you used for the adapter matches where you
   actually wrote the file.
3. Tell the user the next steps: install `@daytona/sdk` (if you didn't),
   make sure `DAYTONA_API_KEY` is available at runtime (per the
   Authentication section above), and run
   `flue run <path-to-the-agent-module> --message "..."` (or `vite dev`
   for the full application) to try it.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
