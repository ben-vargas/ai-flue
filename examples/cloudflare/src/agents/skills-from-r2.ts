'use agent';
/**
 * Demonstrates hydrating a cloudflare-computer `Workspace` from an R2 bucket
 * and using a skill discovered from the hydrated files. The bucket hydration
 * is one-time setup for the environment, not per-render work, so it lives
 * inside a self-authored `SandboxFactory` passed to `useSandbox` — lazy, per
 * the `SandboxFactory` contract: constructing the factory object is cheap;
 * the expensive R2 read happens once, inside `createSandbox()`, at
 * initialization. The skill invocation lives in the model-callable
 * `check_spam` tool below (`harness: true` gives its run a child harness
 * whose scratch session discovers the same hydrated skills — the prompt
 * names the skill and requires a structured verdict):
 *
 *   curl -X POST /agents/skills-from-r2/<id> \
 *     -H 'Content-Type: application/json' \
 *     -d '{"kind": "user", "body": "Check this message for spam: CONGRATS! You won a free iPhone: http://bit.ly/xyz"}'
 *
 * then read the verdict from the conversation stream: GET /agents/skills-from-r2/<id>
 */
import { env } from 'cloudflare:workers';
import type { Workspace } from '@cloudflare/computer';
import { defineTool, useModel, useSandbox, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { getComputerSandbox, getComputerWorkspace } from '../sandboxes/cloudflare-computer';

export { workspaceHost as cloudflare } from '../sandboxes/cloudflare-computer';

interface Env {
	KNOWLEDGE_BASE: R2Bucket;
	LOADER: WorkerLoader;
}

const HYDRATION_SENTINEL = '/.hydrated';
// The agent's working directory; hydrated skills land at
// `<HYDRATION_ROOT>/.agents/skills/...` where the harness discovers them.
const HYDRATION_ROOT = '/workspace';

/**
 * Copy every object from the bucket into the workspace under `root`. R2
 * bodies stream straight into the durable filesystem — no full-file
 * buffering. Read-only data that never changes could use an R2 mount
 * (`WorkspaceOptions.mounts`) instead; a copy keeps the tree writable.
 */
async function hydrateFromBucket(
	workspace: Workspace,
	bucket: R2Bucket,
	root: string,
): Promise<void> {
	let cursor: string | undefined;
	while (true) {
		const listing = await bucket.list({ cursor });
		for (const obj of listing.objects) {
			if (obj.key === '' || obj.key.endsWith('/')) continue;
			const body = await bucket.get(obj.key);
			if (!body) continue;
			await workspace.fs.writeFile(`${root}/${obj.key}`, body.body);
		}

		if (!listing.truncated) break;
		if (!listing.cursor) {
			throw new Error('[flue] R2 listing was truncated but did not include a cursor.');
		}
		cursor = listing.cursor;
	}
}

const checkSpam = defineTool({
	name: 'check_spam',
	description:
		'Classify a message as spam or not using the spam-filter skill from the hydrated knowledge base. Returns a structured verdict.',
	input: v.object({ message: v.string() }),
	output: v.object({
		spam: v.boolean(),
		confidence: v.picklist(['low', 'medium', 'high']),
		reasoning: v.string(),
	}),
	harness: true,
	async run({ harness, data }) {
		const result = await harness.prompt(
			`Use the spam-filter skill to classify the following message:\n\n${data.message}`,
			{
				result: v.object({
					spam: v.boolean(),
					confidence: v.picklist(['low', 'medium', 'high']),
					reasoning: v.string(),
				}),
			},
		);
		return { output: result.data };
	},
});

export function SkillsFromR2() {
	useModel('cloudflare/@cf/moonshotai/kimi-k2.6');
	// Lazy, per the SandboxFactory contract: constructing this object (and the
	// inner `getComputerSandbox()` factory it wraps) is cheap; the expensive R2
	// bucket read happens once, inside createSandbox(), at initialization —
	// never on a re-render.
	const { KNOWLEDGE_BASE, LOADER } = env as unknown as Env;
	const workspace = getComputerWorkspace({ loader: LOADER });
	const computer = getComputerSandbox({ loader: LOADER });
	useSandbox({
		async createSandbox(options) {
			const hydrated = await workspace.fs.stat(HYDRATION_SENTINEL).then(
				() => true,
				() => false,
			);
			if (!hydrated) {
				await hydrateFromBucket(workspace, KNOWLEDGE_BASE, HYDRATION_ROOT);
				await workspace.fs.writeFile(HYDRATION_SENTINEL, new Date().toISOString());
			}
			return computer.createSandbox(options);
		},
	});
	useTool(checkSpam);
	return 'When asked whether a message is spam, call the check_spam tool with the message text and report its verdict.';
}
