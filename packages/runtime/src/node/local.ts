/**
 * `local()` — Sandbox factory binding directly to the host on the Node target.
 *
 * Thin `SandboxFactory` wrapper around `createLocalSandbox` from
 * `./local-env.ts`. The helper holds the real implementation (host fs +
 * `child_process.spawn`, env allowlist resolution); this file just adapts
 * it to the public `useSandbox(...)` surface that sandbox adapters plug into.
 *
 * For full semantics — env allowlist, cwd defaulting, `exec` env layering —
 * see `LocalSandboxOptions` and `DEFAULT_LOCAL_ENV_ALLOWLIST` in
 * `./local-env.ts`.
 */
import type { SandboxFactory } from '../types.ts';
import { createLocalSandbox, type LocalSandboxOptions } from './local-env.ts';

export type { LocalSandboxOptions } from './local-env.ts';

export function local(options: LocalSandboxOptions = {}): SandboxFactory {
	return {
		createSandbox: async () => createLocalSandbox(options),
	};
}
