import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';

const cli = new URL('../dist/flue.js', import.meta.url);

async function runCli(args) {
	const child = spawn(process.execPath, [cli.pathname, ...args], {
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (chunk) => {
		stdout += chunk;
	});
	child.stderr.on('data', (chunk) => {
		stderr += chunk;
	});
	const [code, signal] = await once(child, 'exit');
	return { code, signal, stdout, stderr };
}

async function withServer(handler, callback) {
	const server = createServer(handler);
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	assert(address && typeof address === 'object');
	try {
		await callback(`http://127.0.0.1:${address.port}`);
	} finally {
		server.close();
		await once(server, 'close');
	}
}

function json(response, body) {
	response.writeHead(200, { 'content-type': 'application/json' });
	response.end(JSON.stringify(body));
}

test('forwards repeated headers to automatic metadata and replay requests', async () => {
	const requests = [];
	await withServer(
		(request, response) => {
			requests.push({ url: request.url, headers: request.headers });
			if (request.url === '/runs/run-1') {
				json(response, { status: 'completed' });
				return;
			}
			json(response, { events: [] });
		},
		async (server) => {
			const result = await runCli([
				'logs',
				'run-1',
				'--server',
				server,
				'--header',
				'Authorization: Bearer secret',
				'--header',
				'X-Tenant-ID: tenant-1',
				'--format',
				'json',
			]);
			assert.equal(result.code, 0, result.stderr);
		},
	);
	assert.deepEqual(
		requests.map((request) => request.url),
		['/runs/run-1', '/runs/run-1/events'],
	);
	for (const request of requests) {
		assert.equal(request.headers.authorization, 'Bearer secret');
		assert.equal(request.headers['x-tenant-id'], 'tenant-1');
	}
});

test('forwards authentication and protocol headers to streams', async () => {
	await withServer(
		(request, response) => {
			assert.equal(request.url, '/runs/run-1/stream');
			assert.equal(request.headers.authorization, 'Bearer secret');
			assert.equal(request.headers.accept, 'text/event-stream');
			assert.equal(request.headers['last-event-id'], '25');
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.end('event: run_end\nid: 26\ndata: {"type":"run_end","runId":"run-1"}\n\n');
		},
		async (server) => {
			const result = await runCli([
				'logs',
				'run-1',
				'--server',
				server,
				'--follow',
				'--since',
				'25',
				'--header',
				'Authorization: Bearer secret',
				'--format',
				'json',
			]);
			assert.equal(result.code, 0, result.stderr);
			assert.match(result.stdout, /"type":"run_end"/);
		},
	);
});

test('rejects redirects instead of forwarding credentials', async () => {
	let redirected = false;
	await withServer(
		(_request, response) => {
			redirected = true;
			response.end();
		},
		async (redirectServer) => {
			await withServer(
				(_request, response) => {
					response.writeHead(302, { location: `${redirectServer}/runs/run-1/events` });
					response.end();
				},
				async (server) => {
					const result = await runCli([
						'logs',
						'run-1',
						'--server',
						server,
						'--no-follow',
						'--header',
						'Authorization: Bearer secret',
					]);
					assert.equal(result.code, 1);
					assert.match(result.stderr, /Failed to reach Flue server/);
				},
			);
		},
	);
	assert.equal(redirected, false);
});

for (const [name, args, message] of [
	['missing value', ['logs', 'run-1', '--header'], /Missing value for --header/],
	['missing separator', ['logs', 'run-1', '--header', 'Authorization'], /expected "Name: value"/],
	[
		'duplicate name',
		['logs', 'run-1', '--header', 'Authorization: one', '--header', 'authorization: two'],
		/Duplicate `flue logs` header/,
	],
	[
		'reserved accept',
		['logs', 'run-1', '--header', 'Accept: application/json'],
		/Cannot set reserved `flue logs` header/,
	],
	[
		'reserved last event id',
		['logs', 'run-1', '--header', 'Last-Event-ID: 25'],
		/Cannot set reserved `flue logs` header/,
	],
	['invalid name', ['logs', 'run-1', '--header', 'Bad Header: value'], /expected "Name: value"/],
]) {
	test(`rejects ${name} headers`, async () => {
		const result = await runCli(args);
		assert.equal(result.code, 1);
		assert.match(result.stderr, message);
	});
}
