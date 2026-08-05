/**
 * Resolution for the Cloudflare Agents SDK (`agents`), which the generated
 * Worker entry imports but the user's project does not have to declare:
 * `@flue/vite` ships it as its own dependency, so every project gets the SDK
 * minor Flue is tested against rather than whatever a scaffolded range would
 * resolve to on install day.
 *
 * A copy reachable from the project root always wins — a project that
 * declares its own `agents` dependency (to run a different SDK version) gets
 * it everywhere, and Vite's default pipeline resolves it with no help from
 * this plugin. Only when the root can't reach one (package managers with
 * strict, non-hoisted layouts) does the plugin resolve from `@flue/vite`'s
 * own install, re-entering Vite's resolver so the active environment's
 * conditions still pick the entry.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

interface CloudflareAgentsResolverState {
	readonly target: 'node' | 'cloudflare';
	readonly root: string;
}

export function cloudflareAgentsResolverPlugin(state: CloudflareAgentsResolverState): Plugin {
	return {
		name: 'flue-cloudflare-agents-resolver',
		async resolveId(source, _importer, options) {
			if (state.target !== 'cloudflare') return null;
			if (source !== 'agents' && !source.startsWith('agents/')) return null;
			if (!state.root || projectReachesAgents(state.root)) return null;
			return this.resolve(source, path.join(getPackageDir(), '__flue_agents_resolve__.mjs'), {
				...options,
				skipSelf: true,
			});
		},
	};
}

/**
 * Whether default resolution from the project root would find an `agents`
 * install: the same walk up the `node_modules` chain the package managers
 * perform. With npm's hoisted layout this is true even when only `@flue/vite`
 * depends on the SDK — and then the reachable copy IS the pinned one, so
 * letting the default pipeline take it is equivalent and keeps dep
 * optimization on its normal path.
 */
function projectReachesAgents(root: string): boolean {
	let dir = path.resolve(root);
	while (true) {
		if (fs.existsSync(path.join(dir, 'node_modules', 'agents', 'package.json'))) return true;
		const parent = path.dirname(dir);
		if (parent === dir) return false;
		dir = parent;
	}
}

function getPackageDir(): string {
	return path.dirname(fileURLToPath(import.meta.url));
}
