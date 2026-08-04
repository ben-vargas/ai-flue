'use agent';
/**
 * Demonstrates hydrating a cloudflare-computer `Workspace` from a git
 * repository via the workspace's built-in git client, then letting the model
 * explore it with the standard shell and file tools. The clone hydration is
 * one-time setup for the environment, not per-render work, so it lives
 * inside a self-authored `SandboxFactory` passed to `useSandbox` — lazy, per
 * the `SandboxFactory` contract: constructing the factory object is cheap;
 * the expensive git clone happens once, inside `createSandbox()`, at
 * initialization.
 *
 *   curl -X POST /agents/skills-from-git/<id> \
 *     -H 'Content-Type: application/json' \
 *     -d '{"kind": "user", "body": "List every top-level file and directory in the repo, then describe the project."}'
 *
 * then read the reply from the conversation stream: GET /agents/skills-from-git/<id>
 */
import { env } from 'cloudflare:workers';
import { useModel, useSandbox } from '@flue/runtime';
import { getComputerSandbox, getComputerWorkspace } from '../sandboxes/cloudflare-computer';

export { workspaceHost as cloudflare } from '../sandboxes/cloudflare-computer';

interface Env {
	LOADER: WorkerLoader;
}

const HYDRATION_SENTINEL = '/.hydrated';
const TARGET_REPO = 'https://github.com/FredKSchott/vinext-starter';
const CLONE_DIR = '/workspace/repo';

export function SkillsFromGit() {
	useModel('cloudflare/@cf/moonshotai/kimi-k2.6');
	// Lazy, per the SandboxFactory contract: constructing this object (and the
	// inner `getComputerSandbox()` factory it wraps) is cheap; the expensive
	// git clone happens once, inside createSandbox(), at initialization —
	// never on a re-render.
	const { LOADER } = env as unknown as Env;
	const workspace = getComputerWorkspace({ loader: LOADER });
	const computer = getComputerSandbox({ loader: LOADER });
	useSandbox(
		{
			async createSandbox(options) {
				const hydrated = await workspace.fs.stat(HYDRATION_SENTINEL).then(
					() => true,
					() => false,
				);
				if (!hydrated) {
					await workspace.git.clone({ url: TARGET_REPO, dir: CLONE_DIR });
					await workspace.fs.writeFile(HYDRATION_SENTINEL, new Date().toISOString());
				}
				return computer.createSandbox(options);
			},
		},
		{ cwd: CLONE_DIR },
	);
	return (
		`You operate inside a clone of ${TARGET_REPO} at ${CLONE_DIR}. ` +
		'When asked about the repository, use the shell and file tools to actually inspect the files ' +
		'before answering — never answer from assumption.'
	);
}
