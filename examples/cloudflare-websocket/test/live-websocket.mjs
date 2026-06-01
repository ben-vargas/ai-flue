import assert from 'node:assert/strict';
import { createFlueClient } from '@flue/sdk';

const httpBaseUrl = process.env.FLUE_WS_BASE_URL ?? 'http://localhost:3584';
const baseUrl = new URL(httpBaseUrl);
baseUrl.protocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:';
const client = createFlueClient({
	baseUrl: new URL('/api', httpBaseUrl).toString(),
	websocketUrl: (url) => {
		url.searchParams.set('token', 'live-test');
		return url;
	},
});

await assertAgentPing();
await assertRejected('/api/agents/chat/live-test');
await assertRejected('/api/workflows/live-smoke');
await assertWorkflow();

async function assertRejected(pathname) {
	const socket = new WebSocket(new URL(pathname, baseUrl));
	await new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error(`Expected ${pathname} to reject the socket upgrade.`)),
			10000,
		);
		socket.addEventListener(
			'open',
			() => {
				clearTimeout(timeout);
				socket.close();
				reject(new Error(`Expected ${pathname} to reject the socket upgrade.`));
			},
			{ once: true },
		);
		socket.addEventListener(
			'error',
			() => {
				clearTimeout(timeout);
				resolve();
			},
			{ once: true },
		);
	});
}

async function assertAgentPing() {
	await retry(async () => {
		const socket = client.agents.connect('chat', 'live-test');
		try {
			await withTimeout(socket.ready);
			await withTimeout(socket.ping());
		} finally {
			socket.close();
		}
	});
}

async function assertWorkflow() {
	await retry(async () => {
		const socket = client.workflows.connect('live-smoke');
		try {
			await withTimeout(socket.ready);
			const output = await withTimeout(socket.invoke({ marker: 'sdk-websocket' }));
			assert.deepEqual(output.result, { echoed: 'sdk-websocket' });
			assert.equal(typeof output.runId, 'string');
		} finally {
			socket.close();
		}
	});
}

function withTimeout(promise) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error('Timed out waiting for WebSocket response.')),
			1000,
		);
		promise.then(
			(value) => {
				clearTimeout(timeout);
				resolve(value);
			},
			(error) => {
				clearTimeout(timeout);
				reject(error);
			},
		);
	});
}

async function retry(operation) {
	const deadline = Date.now() + 10000;
	let lastError;
	while (Date.now() < deadline) {
		try {
			await operation();
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	throw lastError ?? new Error('Unable to connect to live WebSocket fixture.');
}
