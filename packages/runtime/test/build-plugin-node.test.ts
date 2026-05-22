import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { createServer } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { build } from '../../cli/src/lib/build.ts';
import { NodePlugin } from '../../cli/src/lib/build-plugin-node.ts';
import type { BuildContext, BuildPlugin } from '../../cli/src/lib/types.ts';

describe('Node build plugin', () => {
	it('derives route metadata from imported agent and workflow modules', () => {
		const entry = new NodePlugin().generateEntryPoint(testBuildContext());

		expect(entry).toContain("import * as handler_triage_0 from '/tmp/triage.ts'");
		expect(entry).toContain("import * as workflow_daily_report_0 from '/tmp/daily-report.ts'");
		expect(entry).toContain('const workflowHandlers = {};');
		expect(entry).toContain('const normalized = normalizeBuiltModules(agentModules, workflowModules);');
		expect(entry).not.toContain('channelModules');
	});

	it('starts a generated server and invokes an HTTP workflow', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-workflow-server-'));
		fs.mkdirSync(path.join(root, 'workflows'));
		fs.mkdirSync(path.join(root, 'node_modules', '@flue'), { recursive: true });
		fs.symlinkSync(process.cwd(), path.join(root, 'node_modules', '@flue', 'runtime'), 'dir');
		fs.writeFileSync(
			path.join(root, 'workflows', 'smoke.ts'),
			`import { http } from '@flue/runtime';\n` +
				`export const channels = [http()];\n` +
				`export async function run() { return { ok: true }; }\n`,
		);
		await build({ root, target: 'node' });

		const port = await findAvailablePort();
		const child = spawn('node', [path.join(root, 'dist', 'server.mjs')], {
			cwd: root,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, PORT: String(port), FLUE_MODE: 'local' },
		});
		try {
			await waitForServer(child, port);
			const response = await fetch(`http://localhost:${port}/workflows/smoke?wait=result`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({}),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ result: { ok: true } });
		} finally {
			child.kill('SIGTERM');
		}
	});

	it('rejects duplicate agent basenames', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-duplicate-agents-'));
		fs.mkdirSync(path.join(root, 'agents'));
		fs.writeFileSync(path.join(root, 'agents', 'assistant.ts'), 'export default createAgent(() => ({ model: false }));\n');
		fs.writeFileSync(path.join(root, 'agents', 'assistant.js'), 'export default createAgent(() => ({ model: false }));\n');

		await expect(build({ root, target: 'node' })).rejects.toThrow('Duplicate agent basename "assistant"');
	});

	it('allows workflow exports unrelated to Flue entrypoints', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-workflow-extra-exports-'));
		fs.mkdirSync(path.join(root, 'workflows'));
		fs.writeFileSync(
			path.join(root, 'workflows', 'draft.ts'),
			`export interface DraftPayload { message: string }\n` +
				`export type DraftResult = { ok: boolean }\n` +
				`export const schema = { type: 'object' };\n` +
				`export function helper() { return 'helper'; }\n` +
				`export async function run() { return { ok: true }; }\n`,
		);

		await expect(build({ root, plugin: parserOnlyPlugin })).resolves.toEqual({ changed: true });
	});

	it('allows agent exports unrelated to Flue entrypoints', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-agent-extra-exports-'));
		fs.mkdirSync(path.join(root, 'agents'));
		fs.writeFileSync(
			path.join(root, 'agents', 'assistant.ts'),
			`export interface AssistantPayload { message: string }\n` +
				`export const metadata = { owner: 'test' };\n` +
				`export function helper() { return 'helper'; }\n` +
				`export default { __flueCreatedAgent: true, initialize: async () => ({ model: false }) };\n`,
		);

		await expect(build({ root, plugin: parserOnlyPlugin })).resolves.toEqual({ changed: true });
	});

	it('rejects legacy default-export agents with triggers using a migration message', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-legacy-agent-'));
		fs.mkdirSync(path.join(root, 'agents'));
		fs.writeFileSync(
			path.join(root, 'agents', 'draft.ts'),
			`export const triggers = { webhook: true };\n` +
				`export default async function handler() { return 'ok'; }\n`,
		);

		await expect(build({ root, plugin: parserOnlyPlugin })).rejects.toThrow('Found legacy 0.7 agent');
	});
});

const parserOnlyPlugin: BuildPlugin = {
	name: 'parser-only',
	bundle: 'none',
	entryFilename: 'server.mjs',
	generateEntryPoint() {
		return 'export default {};\n';
	},
};

async function findAvailablePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, () => {
			const address = server.address();
			if (address && typeof address === 'object') {
				server.close(() => resolve(address.port));
				return;
			}
			server.close(() => reject(new Error('Could not determine port')));
		});
		server.on('error', reject);
	});
}

async function waitForServer(child: ChildProcess, port: number): Promise<void> {
	let output = '';
	child.stderr?.on('data', (chunk) => {
		output += chunk.toString();
	});
	child.stdout?.on('data', (chunk) => {
		output += chunk.toString();
	});
	for (let attempt = 0; attempt < 50; attempt++) {
		if (child.exitCode !== null) {
			throw new Error(`Generated server exited before listening:\n${output}`);
		}
		try {
			const response = await fetch(`http://localhost:${port}/runs/not-found`);
			await response.text();
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
	throw new Error(`Generated server did not begin listening:\n${output}`);
}

function testBuildContext(): BuildContext {
	return {
		agents: [{ name: 'triage', filePath: '/tmp/triage.ts', hasChannels: true, hasReceive: true, hasDefaultAgent: true }],
		workflows: [{ name: 'daily-report', filePath: '/tmp/daily-report.ts', hasChannels: true }],
		manifest: {
			agents: [{ name: 'triage', channels: {}, receive: true, created: true }],
			workflows: [{ name: 'daily-report', channels: {} }],
		},
		root: '/tmp/flue-test',
		output: '/tmp/flue-test/dist',
		runtimeVersion: '0.0.0-test',
		options: { root: '/tmp/flue-test', target: 'node' },
	};
}
