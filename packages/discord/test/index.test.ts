import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
	createDiscordChannel,
	type DiscordChannel,
	InvalidDiscordConversationKeyError,
} from '../src/index.ts';

const encoder = new TextEncoder();
const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
	'sign',
	'verify',
])) as CryptoKeyPair;
const publicKey = toHex(new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey)));

const messageResponse = { type: 4 as const, data: { content: 'Accepted.' } };

describe('createDiscordChannel()', () => {
	it('declares one fixed interactions route when constructed', () => {
		const interactions = vi.fn((_input: unknown) => messageResponse);
		const discord = createDiscordChannel({ publicKey, interactions });

		expect(discord.routes).toEqual([
			{ method: 'POST', path: '/interactions', handler: expect.any(Function) },
		]);
		expect(interactions).not.toHaveBeenCalled();
	});

	it('returns PONG without invoking the callback when receiving a signed PING', async () => {
		const interactions = vi.fn((_input: unknown) => messageResponse);
		const discord = createDiscordChannel({ publicKey, interactions });

		const response = await channelApp(discord).request(await signedRequest({ type: 1 }));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ type: 1 });
		expect(interactions).not.toHaveBeenCalled();
	});

	it('passes the provider-native interaction through when authentication succeeds', async () => {
		const interactions = vi.fn((_input: unknown) => messageResponse);
		const discord = createDiscordChannel({ publicKey, interactions });
		const interaction = commandInteraction({
			data: {
				id: 'CMD1',
				type: 1,
				name: 'ask',
				options: [{ name: 'question', type: 3, value: 'hello' }],
			},
			entitlements: [{ id: 'E1', sku_id: 'S1', application_id: 'A1', type: 8, deleted: false }],
		});

		const response = await channelApp(discord).request(await signedRequest(interaction));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(messageResponse);
		expect(interactions).toHaveBeenCalledOnce();
		expect(
			(interactions.mock.calls[0]?.[0] as { interaction?: unknown } | undefined)?.interaction,
		).toEqual(interaction);
	});

	it('forwards a future numeric interaction type when the signed payload is otherwise valid', async () => {
		const interactions = vi.fn((_input: unknown) => messageResponse);
		const discord = createDiscordChannel({ publicKey, interactions });
		const interaction = { type: 99, future_field: { preserved: true } };

		const response = await channelApp(discord).request(await signedRequest(interaction));

		expect(response.status).toBe(200);
		expect(
			(interactions.mock.calls[0]?.[0] as { interaction?: unknown } | undefined)?.interaction,
		).toEqual(interaction);
	});

	it('does not reject an authenticated payload based on application_id', async () => {
		const interactions = vi.fn((_input: unknown) => messageResponse);
		const discord = createDiscordChannel({ publicKey, interactions });
		const interaction = commandInteraction({ application_id: 'another-application' });

		const response = await channelApp(discord).request(await signedRequest(interaction));

		expect(response.status).toBe(200);
		expect(
			(interactions.mock.calls[0]?.[0] as { interaction?: unknown } | undefined)?.interaction,
		).toEqual(interaction);
	});

	it('passes Hono responses through when the callback returns one', async () => {
		const discord = createDiscordChannel({
			publicKey,
			interactions: ({ c }) => c.json({ accepted: true }, 202),
		});

		const response = await channelApp(discord).request(await signedRequest(commandInteraction()));

		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ accepted: true });
	});

	it('returns 500 when the callback throws', async () => {
		const discord = createDiscordChannel({
			publicKey,
			interactions() {
				throw new Error('failed');
			},
		});

		const response = await channelApp(discord).request(await signedRequest(commandInteraction()));

		expect(response.status).toBe(500);
	});

	it('rejects changed body bytes before invoking the callback', async () => {
		const interactions = vi.fn((_input: unknown) => messageResponse);
		const discord = createDiscordChannel({ publicKey, interactions });
		const signed = await signedRequest(commandInteraction());
		const changed = new Request(signed.url, {
			method: 'POST',
			headers: signed.headers,
			body: JSON.stringify(commandInteraction({ id: 'changed' })),
		});

		const response = await channelApp(discord).request(changed);

		expect(response.status).toBe(401);
		expect(interactions).not.toHaveBeenCalled();
	});

	it('rejects missing or malformed authentication before invoking the callback', async () => {
		const interactions = vi.fn((_input: unknown) => messageResponse);
		const discord = createDiscordChannel({ publicKey, interactions });
		const body = JSON.stringify(commandInteraction());
		const missing = new Request('https://example.test/interactions', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body,
		});
		const malformed = new Request('https://example.test/interactions', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-signature-ed25519': 'not-hex',
				'x-signature-timestamp': '1717971234',
			},
			body,
		});

		expect((await channelApp(discord).request(missing)).status).toBe(401);
		expect((await channelApp(discord).request(malformed)).status).toBe(401);
		expect(interactions).not.toHaveBeenCalled();
	});

	it('rejects unsupported content types and malformed JSON', async () => {
		const interactions = vi.fn((_input: unknown) => messageResponse);
		const discord = createDiscordChannel({ publicKey, interactions });
		const wrongType = await signedRequest(commandInteraction());
		wrongType.headers.set('content-type', 'text/plain');
		const malformed = await signedTextRequest('{');

		expect((await channelApp(discord).request(wrongType)).status).toBe(415);
		expect((await channelApp(discord).request(malformed)).status).toBe(400);
		expect(interactions).not.toHaveBeenCalled();
	});

	it('rejects declared and streamed bodies over the configured limit', async () => {
		const interactions = vi.fn((_input: unknown) => messageResponse);
		const discord = createDiscordChannel({ publicKey, bodyLimit: 8, interactions });
		const declared = new Request('https://example.test/interactions', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'content-length': '9' },
			body: '{}',
		});
		const streamed = new Request('https://example.test/interactions', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-signature-ed25519': '00'.repeat(64),
				'x-signature-timestamp': '1717971234',
			},
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode('12345'));
					controller.enqueue(encoder.encode('6789'));
					controller.close();
				},
			}),
			duplex: 'half',
		} as RequestInit);

		expect((await channelApp(discord).request(declared)).status).toBe(413);
		expect((await channelApp(discord).request(streamed)).status).toBe(413);
		expect(interactions).not.toHaveBeenCalled();
	});

	it('rejects malformed content length before reading the body', async () => {
		const discord = createDiscordChannel({ publicKey, interactions: () => messageResponse });
		const request = new Request('https://example.test/interactions', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'content-length': 'unknown' },
			body: '{}',
		});

		expect((await channelApp(discord).request(request)).status).toBe(400);
	});

	it('round-trips canonical destination references when keys are valid', () => {
		const discord = createDiscordChannel({ publicKey, interactions: () => messageResponse });
		const ref = {
			type: 'guild' as const,
			guildId: 'G:1',
			channelId: 'C/1?#',
		};
		const key = discord.conversationKey(ref);

		expect(discord.parseConversationKey(key)).toEqual(ref);
		expect(
			discord.parseConversationKey(discord.conversationKey({ type: 'private', channelId: 'P:1' })),
		).toEqual({ type: 'private', channelId: 'P:1' });
	});

	it('rejects noncanonical or foreign conversation keys when parsing', () => {
		const discord = createDiscordChannel({ publicKey, interactions: () => messageResponse });

		expect(() => discord.parseConversationKey('slack:v1:C1')).toThrow(
			InvalidDiscordConversationKeyError,
		);
		expect(() => discord.parseConversationKey('discord:v1:dm:C%31')).toThrow(
			InvalidDiscordConversationKeyError,
		);
	});
});

function channelApp(channel: DiscordChannel): Hono {
	const app = new Hono();
	for (const route of channel.routes) app.on(route.method, route.path, route.handler);
	return app;
}

function commandInteraction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: 2,
		id: 'I1',
		application_id: 'A1',
		token: 'interaction-token',
		version: 1,
		guild_id: 'G1',
		context: 0,
		channel_id: 'C1',
		channel: { id: 'C1', type: 0 },
		member: { user: { id: 'U1' } },
		locale: 'en-US',
		guild_locale: 'en-GB',
		authorizing_integration_owners: { 0: 'G1' },
		data: { id: 'CMD1', type: 1, name: 'ask', options: [] },
		...overrides,
	};
}

async function signedRequest(raw: unknown): Promise<Request> {
	return signedTextRequest(JSON.stringify(raw));
}

async function signedTextRequest(body: string): Promise<Request> {
	const timestamp = '1717971234';
	const signature = await sign(keyPair.privateKey, timestamp, body);
	return new Request('https://example.test/interactions', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-signature-ed25519': signature,
			'x-signature-timestamp': timestamp,
		},
		body,
	});
}

async function sign(privateKey: CryptoKey, timestamp: string, body: string): Promise<string> {
	const prefix = encoder.encode(timestamp);
	const bytes = encoder.encode(body);
	const signed = new Uint8Array(prefix.byteLength + bytes.byteLength);
	signed.set(prefix);
	signed.set(bytes, prefix.byteLength);
	return toHex(new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, signed)));
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
