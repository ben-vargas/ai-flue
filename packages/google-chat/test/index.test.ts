import { Hono } from 'hono';
import { type CryptoKey, exportJWK, generateKeyPair, importPKCS8, SignJWT } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
	createGoogleChatChannel,
	type GoogleChatChannel,
	InvalidGoogleChatConversationKeyError,
	InvalidGoogleChatInputError,
} from '../src/index.ts';

const CHAT_IDENTITY = 'chat@system.gserviceaccount.com';
const ENDPOINT_AUDIENCE = 'https://assistant.example.test/channels/google-chat/interactions';
const PUBSUB_AUDIENCE = 'https://assistant.example.test/channels/google-chat/events';
const PUBSUB_IDENTITY = 'workspace-push@synthetic-project.iam.gserviceaccount.com';
const PUBSUB_SUBSCRIPTION = 'projects/synthetic-project/subscriptions/google-chat-events';
const JWKS_URL = 'https://keys.example.test/google';
const CERTIFICATES_URL = 'https://keys.example.test/chat-x509';
const PROJECT_NUMBER = '456700123998';
const encoder = new TextEncoder();

const SYNTHETIC_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDfatQsxJCGlooR
e+xMOqgwK7w+w6+8f/p4WpNzSHB1VZSMkPVKM2rtWKkZxjrfuBCy7uS4EZ7WUzMG
odM/BWsTiPx6YD77CIp+BQPzAT5SAqolgoJ5sw8OlZxb/qwfVuNFPPewwNT7f5GW
fzE00D9oGxCktbaJzFquTdaCCtrYic3W4n8oHITEA7DVlBstfcVWIwYbWmgyK4uZ
XWVxx+8TrkHPcuot8s8Sm9niCgNAY7J3OZC1LOeXaFiZrs8VGAmiM7WHh3LQkrXn
USh/JI+UReymu92bFp8nmJQMpHZV0/gyffDGGFYgwnPk3K0GtyfARwqnECdJMUHl
/0JlQ/HJAgMBAAECggEAVme4ez/iLUsXRr/ImYqt9UNU4GlKE/ri4Z0WHaXMaHSa
qOp/Ex1jozuA2skBh/hl7O3bYxzdc0JmH5CCZIMx8DIwgxup/+hDt401A8xdT9Zb
+3nIAE0x65ANEr8hzlUKPILhwGgzdrjVk4DJhQVtIFQnUaw9VnnEMFlGNrEABnI8
JdtcUbmNHeUMGAWba8zx7HS/jxDtoR5Sci7mP+7wGnPAU2dtUGxdkQFsi3D8Ukg2
r57k3JWHz9yG08H39gm5eIZm0eTcJChAIU1Vz/28xa33Tu4bkrnFS5gDuRY2+C2b
CAnKFk3PYPo3za2pxDHZavz6oPksWZ1MtB/HJw9roQKBgQD3GhOKR1RuwQILo/4W
gICmgsRqhJf3TZKl9Nx4l3ZsRSYHkSLrOcBmsIoYk5qTYKBpBVFsQ4uYuGRjK5Pm
Y9CYy3xtbR2TTBkBC3FBk2ICwZQ0Cp5gQUEWhZzkNG+CP16LEyQcdtD6NZlVZ3Nq
23YsYSEvd39WbFJY4DTrdglg5QKBgQDndmo3GrKQZDq7V79k9Pq4Jyd14GfGQm3A
2j5MwYpqSiPX/z/O4N5LFCBIo/f5XZX83ecL8i6BTCzWYRFbY/R7it1YixhDVnRz
k1xI9d1eWQUEiL+21TmWEowBcXKqSqaaIfLOTyiY1crqqBmdIgav+agsSn6uxtXq
97ndBDYTFQKBgDwx2QK9f57/W500VOhsY2qsvmZoaJCxEAFnlfG2i/2yFqKPQ59j
0S/y36E/C8/NISaUShKCndYVTTcvXXcpZ55hK62IgETqq8iqXeuomJ6tQ4ot8Ajo
vI9c+yxIbcWf5Esi3ZAljaD2P6Ujb2VfkvkarDfg9185QhIuhBW8CmrVAoGBAMRX
ragKzJgxfaS3vZJ9QUT/abjTYBRM+18RgrGHp8ucEqXCTzVFiSu06eHUvaBZo8a5
0alPieWCYbKE6r1Un+pAlJzseOt+JhB4W1tEvMCw0NHU0pPcchn8p6j9vF/6LTMo
QxiBC5YCHTxK1ld1qqiSJfdURfwqjQHhnFeAoAI1AoGBALG/Bjlv0jpe3rrEFU2J
pnQbdCtTQYg6Qykqi/h7niWIkdkxB/BY1zeSCmWK6mdFhRWUYVLcC+sVr+ZIi9qq
ibEkFAdWW9vIf1+VEPiEg+D+FqWoGTCcFw0dLW+DHfGTaV1WX9JqEC5p2qK25wxS
sm/A/fHwtd0ZmmpzRBWeAyRZ
-----END PRIVATE KEY-----`;

const SYNTHETIC_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIICxjCCAa4CCQDuaZiYnfU5vTANBgkqhkiG9w0BAQsFADAlMSMwIQYDVQQDDBpz
eW50aGV0aWMtZ29vZ2xlLWNoYXQudGVzdDAeFw0yNjA2MTMxNzM3MzVaFw0zNjA2
MTAxNzM3MzVaMCUxIzAhBgNVBAMMGnN5bnRoZXRpYy1nb29nbGUtY2hhdC50ZXN0
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA32rULMSQhpaKEXvsTDqo
MCu8PsOvvH/6eFqTc0hwdVWUjJD1SjNq7VipGcY637gQsu7kuBGe1lMzBqHTPwVr
E4j8emA++wiKfgUD8wE+UgKqJYKCebMPDpWcW/6sH1bjRTz3sMDU+3+Rln8xNNA/
aBsQpLW2icxark3Wggra2InN1uJ/KByExAOw1ZQbLX3FViMGG1poMiuLmV1lccfv
E65Bz3LqLfLPEpvZ4goDQGOydzmQtSznl2hYma7PFRgJojO1h4dy0JK151EofySP
lEXsprvdmxafJ5iUDKR2VdP4Mn3wxhhWIMJz5NytBrcnwEcKpxAnSTFB5f9CZUPx
yQIDAQABMA0GCSqGSIb3DQEBCwUAA4IBAQDdSfGN68GJJZ3pDYv+tEf+SNZNnn0F
xE9JUK2AMEsEe00UTNiEjRB/zpbT6rFe6eNWEx5pNjE+7fdzvyL7fbKw0ch4Jb8X
odNlR6ECyXiGUsUkikkJvnAq71o2Wb/NkZI0EvGaRbbB2cN0UtrY3FZoty8FBAnG
btDWTl0kbIcsuV5rBzDsycXrl8OP5LjYjL5R7I2K/eTwRX9HCB+42oSQIx8cVR/U
LhdVxSD+CpVVSyqiQBJmOAyDS3F2I+dt6KeVLKQhWjNvhxC/0wTO4i7I/Lm6L1ls
AiG8pBjuPyBEIaHivmJ3GgsZP8rsHIz8ybwjY8+l1ncJMToiJIN1uK3M
-----END CERTIFICATE-----`;

let oidcPrivateKey: CryptoKey;
let oidcJwk: JsonWebKey;
let x509PrivateKey: CryptoKey;

beforeAll(async () => {
	const pair = await generateKeyPair('RS256');
	oidcPrivateKey = pair.privateKey;
	oidcJwk = await exportJWK(pair.publicKey);
	x509PrivateKey = await importPKCS8(SYNTHETIC_PRIVATE_KEY, 'RS256');
});

describe('createGoogleChatChannel()', () => {
	it('passes a provider-native interaction through when endpoint authentication succeeds', async () => {
		const payload = {
			type: 'MESSAGE',
			space: {
				name: 'spaces/cobalt-lab',
				spaceType: 'SPACE',
				type: 'ROOM',
				futureSpaceField: true,
			},
			message: {
				text: 'summarize the launch notes',
				thread: { name: 'spaces/cobalt-lab/threads/thread-15' },
				futureMessageField: { preserved: true },
			},
			futureTopLevelField: 42,
		};
		const interactions = vi.fn(({ payload }) => ({ received: payload.type }));
		const channel = endpointChannel(interactions);

		const response = await app(channel).request('/interactions', await interactionInit(payload));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ received: 'MESSAGE' });
		expect(interactions.mock.calls[0]?.[0].payload).toEqual(payload);
	});

	it('passes current and future direct interaction types through when authentication succeeds', async () => {
		const interactions = vi.fn((_input: { payload: unknown }) => undefined);
		const channel = endpointChannel(interactions);
		const widget = { type: 'WIDGET_UPDATED', common: { invokedFunction: 'refresh' } };
		const future = { type: 'FUTURE_INTERACTION', future: { preserved: true } };

		expect(
			(await app(channel).request('/interactions', await interactionInit(widget))).status,
		).toBe(200);
		expect(
			(await app(channel).request('/interactions', await interactionInit(future))).status,
		).toBe(200);
		expect(interactions.mock.calls.map(([input]) => input.payload)).toEqual([widget, future]);
	});

	it('passes an interaction when its project-number token is valid', async () => {
		const interactions = vi.fn(({ payload }) => ({ type: payload.type }));
		const fetcher = vi.fn(async () =>
			Response.json({ 'synthetic-x509-key': SYNTHETIC_CERTIFICATE }),
		);
		const channel = createGoogleChatChannel({
			fetch: fetcher,
			interactions: {
				authentication: {
					type: 'project-number',
					projectNumber: PROJECT_NUMBER,
					certificatesUrl: CERTIFICATES_URL,
				},
				handler: interactions,
			},
		});
		const token = await new SignJWT({})
			.setProtectedHeader({ alg: 'RS256', kid: 'synthetic-x509-key' })
			.setIssuer(CHAT_IDENTITY)
			.setAudience(PROJECT_NUMBER)
			.setIssuedAt()
			.setExpirationTime('5m')
			.sign(x509PrivateKey);

		const response = await app(channel).request('/interactions', {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ type: 'CARD_CLICKED', action: { actionMethodName: 'approve' } }),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ type: 'CARD_CLICKED' });
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it('coalesces concurrent unknown OIDC keys and cools down failed cold discovery', async () => {
		const unknownToken = await signOidcToken(ENDPOINT_AUDIENCE, CHAT_IDENTITY, {
			kid: 'unknown-key',
		});
		const unknownFetcher = keyFetcher();
		const unknownChannel = createGoogleChatChannel({
			fetch: unknownFetcher,
			interactions: {
				authentication: { type: 'endpoint-url', audience: ENDPOINT_AUDIENCE, jwksUrl: JWKS_URL },
				handler: vi.fn(),
			},
		});
		const unknownRequest = () =>
			app(unknownChannel).request(
				'/interactions',
				requestWithToken({ type: 'MESSAGE' }, unknownToken),
			);

		const unknownResponses = await Promise.all([
			unknownRequest(),
			unknownRequest(),
			unknownRequest(),
		]);

		expect(unknownResponses.map((response) => response.status)).toEqual([401, 401, 401]);
		expect(unknownFetcher).toHaveBeenCalledOnce();

		const failedFetcher = vi.fn(async () => new Response(null, { status: 503 }));
		const failedChannel = createGoogleChatChannel({
			fetch: failedFetcher,
			interactions: {
				authentication: { type: 'endpoint-url', audience: ENDPOINT_AUDIENCE, jwksUrl: JWKS_URL },
				handler: vi.fn(),
			},
		});
		const failedRequest = () =>
			app(failedChannel).request(
				'/interactions',
				requestWithToken({ type: 'MESSAGE' }, unknownToken),
			);

		expect((await failedRequest()).status).toBe(401);
		expect((await failedRequest()).status).toBe(401);
		expect(failedFetcher).toHaveBeenCalledOnce();
	});

	it('coalesces concurrent unknown X509 keys and cools down failed cold discovery', async () => {
		const token = await new SignJWT({})
			.setProtectedHeader({ alg: 'RS256', kid: 'unknown-key' })
			.setIssuer(CHAT_IDENTITY)
			.setAudience(PROJECT_NUMBER)
			.setIssuedAt()
			.setExpirationTime('5m')
			.sign(x509PrivateKey);
		const createChannel = (fetcher: typeof globalThis.fetch) =>
			createGoogleChatChannel({
				fetch: fetcher,
				interactions: {
					authentication: {
						type: 'project-number',
						projectNumber: PROJECT_NUMBER,
						certificatesUrl: CERTIFICATES_URL,
					},
					handler: vi.fn(),
				},
			});
		const unknownFetcher = vi.fn(async () =>
			Response.json({ 'synthetic-x509-key': SYNTHETIC_CERTIFICATE }),
		);
		const unknownChannel = createChannel(unknownFetcher);
		const request = (channel: GoogleChatChannel) =>
			app(channel).request('/interactions', requestWithToken({ type: 'MESSAGE' }, token));

		const responses = await Promise.all([
			request(unknownChannel),
			request(unknownChannel),
			request(unknownChannel),
		]);

		expect(responses.map((response) => response.status)).toEqual([401, 401, 401]);
		expect(unknownFetcher).toHaveBeenCalledOnce();

		const failedFetcher = vi.fn(async () => new Response(null, { status: 503 }));
		const failedChannel = createChannel(failedFetcher);

		expect((await request(failedChannel)).status).toBe(401);
		expect((await request(failedChannel)).status).toBe(401);
		expect(failedFetcher).toHaveBeenCalledOnce();
	});

	it('rejects endpoint tokens with another identity or signing key', async () => {
		const interactions = vi.fn(() => undefined);
		const channel = endpointChannel(interactions);
		const wrongIdentity = await signOidcToken(ENDPOINT_AUDIENCE, 'another@example.test');
		const otherPair = await generateKeyPair('RS256');
		const wrongKey = await new SignJWT({ email: CHAT_IDENTITY, email_verified: true })
			.setProtectedHeader({ alg: 'RS256', kid: 'synthetic-google-key' })
			.setIssuer('https://accounts.google.com')
			.setAudience(ENDPOINT_AUDIENCE)
			.setIssuedAt()
			.setExpirationTime('5m')
			.sign(otherPair.privateKey);
		const request = (token: string) => ({
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ type: 'REMOVED_FROM_SPACE' }),
		});

		expect((await app(channel).request('/interactions', request(wrongIdentity))).status).toBe(401);
		expect((await app(channel).request('/interactions', request(wrongKey))).status).toBe(401);
		expect(interactions).not.toHaveBeenCalled();
	});

	it('rejects missing or malformed bearer authentication when the body is valid', async () => {
		const interactions = vi.fn(() => undefined);
		const channel = endpointChannel(interactions);
		const body = JSON.stringify({ type: 'MESSAGE' });
		const missing = {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body,
		};
		const malformed = {
			method: 'POST',
			headers: { authorization: 'Basic invalid', 'content-type': 'application/json' },
			body,
		};

		expect((await app(channel).request('/interactions', missing)).status).toBe(401);
		expect((await app(channel).request('/interactions', malformed)).status).toBe(401);
		expect(interactions).not.toHaveBeenCalled();
	});

	it('rejects endpoint tokens when audience, issuer, or expiration is invalid', async () => {
		const interactions = vi.fn(() => undefined);
		const channel = endpointChannel(interactions);
		const wrongAudience = await signOidcToken('https://wrong.example.test', CHAT_IDENTITY);
		const wrongIssuer = await signOidcToken(ENDPOINT_AUDIENCE, CHAT_IDENTITY, {
			issuer: 'https://issuer.example.test',
		});
		const expired = await signOidcToken(ENDPOINT_AUDIENCE, CHAT_IDENTITY, {
			expirationTime: Math.floor(Date.now() / 1000) - 60,
		});
		const request = (token: string) => requestWithToken({ type: 'REMOVED_FROM_SPACE' }, token);

		expect((await app(channel).request('/interactions', request(wrongAudience))).status).toBe(401);
		expect((await app(channel).request('/interactions', request(wrongIssuer))).status).toBe(401);
		expect((await app(channel).request('/interactions', request(expired))).status).toBe(401);
		expect(interactions).not.toHaveBeenCalled();
	});

	it('rejects malformed JSON and unsupported media types before invoking the callback', async () => {
		const interactions = vi.fn(() => undefined);
		const channel = endpointChannel(interactions);
		const malformed = {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{',
		};
		const unsupported = {
			method: 'POST',
			headers: { 'content-type': 'text/plain' },
			body: JSON.stringify({ type: 'MESSAGE' }),
		};

		expect((await app(channel).request('/interactions', malformed)).status).toBe(400);
		expect((await app(channel).request('/interactions', unsupported)).status).toBe(415);
		expect(interactions).not.toHaveBeenCalled();
	});

	it('passes Hono and cross-realm responses through when callbacks return them', async () => {
		const honoChannel = endpointChannel(({ c }) => c.json({ accepted: true }, 202));
		const foreignResponse = new Response('foreign', { status: 207 });
		const foreignPrototype = Object.create(Object.getPrototypeOf(foreignResponse));
		Object.defineProperty(foreignPrototype, Symbol.toStringTag, { value: 'Response' });
		Object.setPrototypeOf(foreignResponse, foreignPrototype);
		const foreignChannel = endpointChannel(() => foreignResponse);

		const hono = await app(honoChannel).request(
			'/interactions',
			await interactionInit({ type: 'APP_HOME' }),
		);
		const foreign = await app(foreignChannel).request(
			'/interactions',
			await interactionInit({ type: 'APP_HOME' }),
		);

		expect(hono.status).toBe(202);
		expect(await hono.json()).toEqual({ accepted: true });
		expect(foreign.status).toBe(207);
		expect(await foreign.text()).toBe('foreign');
	});

	it('lets handler errors flow through Hono when a callback throws', async () => {
		const channel = endpointChannel(() => {
			throw new Error('failed');
		});
		const hono = app(channel);
		hono.onError((error, c) => c.json({ handled: error.message }, 503));

		const response = await hono.request(
			'/interactions',
			await interactionInit({ type: 'APP_HOME' }),
		);

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ handled: 'failed' });
	});

	it('rejects declared and streamed bodies over the configured limit', async () => {
		const interactions = vi.fn(() => undefined);
		const channel = endpointChannel(interactions, 8);
		const declared = new Request('https://example.test/interactions', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'content-length': '9' },
			body: '{}',
		});
		const streamed = new Request('https://example.test/interactions', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode('12345'));
					controller.enqueue(encoder.encode('6789'));
					controller.close();
				},
			}),
			duplex: 'half',
		} as RequestInit);

		expect((await app(channel).request(declared)).status).toBe(413);
		expect((await app(channel).request(streamed)).status).toBe(413);
		expect(interactions).not.toHaveBeenCalled();
	});

	it('passes the complete Pub/Sub delivery when authentication succeeds', async () => {
		const workspaceEvents = vi.fn(({ delivery }) => ({ id: delivery.message.messageId }));
		const channel = workspaceChannel(workspaceEvents);
		const delivery = pubsubDelivery({
			eventType: 'google.workspace.chat.space.v1.deleted',
			subject: '//chat.googleapis.com/spaces/amber-ops',
			data: { space: { name: 'spaces/amber-ops' } },
		});
		delivery.deliveryAttempt = 3;
		delivery.message.orderingKey = 'space-amber-ops';
		delivery.futureEnvelopeField = { preserved: true };

		const response = await app(channel).request('/events', await eventInit(delivery));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ id: 'pubsub-message-100' });
		expect(workspaceEvents.mock.calls[0]?.[0].delivery).toEqual(delivery);
	});

	it('passes documented Chat and Cloud Identity Workspace event subjects', async () => {
		const workspaceEvents = vi.fn((_input: { delivery: unknown }) => undefined);
		const channel = workspaceChannel(workspaceEvents);
		const deliveries = [
			pubsubDelivery({
				eventType: 'google.workspace.chat.future.v2.changed',
				subject: '//chat.googleapis.com/spaces/-',
				data: { futureResource: { preserved: true } },
			}),
			pubsubDelivery({
				eventType: 'google.workspace.identity.user.v1.updated',
				subject: '//cloudidentity.googleapis.com/users/123456789',
				data: { user: { name: 'users/123456789' } },
			}),
		];

		for (const delivery of deliveries) {
			expect((await app(channel).request('/events', await eventInit(delivery))).status).toBe(200);
		}
		expect(workspaceEvents.mock.calls.map(([input]) => input.delivery)).toEqual(deliveries);
	});

	it('returns authentication failure when unauthenticated Pub/Sub data is invalid', async () => {
		const workspaceEvents = vi.fn(() => undefined);
		const channel = workspaceChannel(workspaceEvents);
		const invalid = pubsubDelivery({
			eventType: 'google.workspace.chat.message.v1.created',
			subject: '//chat.googleapis.com/spaces/auth-order',
			data: {},
		});
		invalid.message.data = 'not base64';

		const response = await app(channel).request('/events', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(invalid),
		});

		expect(response.status).toBe(401);
		expect(workspaceEvents).not.toHaveBeenCalled();
	});

	it('rejects Pub/Sub deliveries when data, CloudEvent relationships, or attempts are invalid', async () => {
		const workspaceEvents = vi.fn(() => undefined);
		const channel = workspaceChannel(workspaceEvents);
		const invalidBase64 = pubsubDelivery({
			eventType: 'google.workspace.chat.message.v1.created',
			subject: '//chat.googleapis.com/spaces/invalid-data',
			data: {},
		});
		invalidBase64.message.data = 'not base64';
		const invalidSource = pubsubDelivery({
			eventType: 'google.workspace.chat.message.v1.created',
			subject: '//chat.googleapis.com/spaces/invalid-source',
			data: {},
		});
		invalidSource.message.attributes['ce-source'] = '//example.test/subscriptions/invalid';
		const invalidSubject = pubsubDelivery({
			eventType: 'google.workspace.chat.message.v1.created',
			subject: '//chat.googleapis.com/users/not-a-space',
			data: {},
		});
		const invalidLifecycle = pubsubDelivery({
			eventType: 'google.workspace.events.subscription.v1.suspended',
			subject: '//workspaceevents.googleapis.com/subscriptions/another',
			data: { subscription: {} },
		});
		const invalidAttempt = pubsubDelivery({
			eventType: 'google.workspace.chat.message.v1.created',
			subject: '//chat.googleapis.com/spaces/invalid-attempt',
			data: {},
		});
		invalidAttempt.deliveryAttempt = 0;

		for (const delivery of [
			invalidBase64,
			invalidSource,
			invalidSubject,
			invalidLifecycle,
			invalidAttempt,
		]) {
			expect((await app(channel).request('/events', await eventInit(delivery))).status).toBe(400);
		}
		expect(workspaceEvents).not.toHaveBeenCalled();
	});

	it('rejects Pub/Sub deliveries with another identity or subscription', async () => {
		const workspaceEvents = vi.fn(() => undefined);
		const channel = workspaceChannel(workspaceEvents);
		const delivery = pubsubDelivery({
			eventType: 'google.workspace.chat.message.v1.created',
			subject: '//chat.googleapis.com/spaces/identity-test',
			data: { message: { space: { name: 'spaces/identity-test' } } },
		});
		const wrongIdentity = await signOidcToken(PUBSUB_AUDIENCE, 'unexpected@example.test');
		const wrongSubscription = { ...delivery, subscription: 'projects/other/subscriptions/events' };

		expect(
			(await app(channel).request('/events', requestWithToken(delivery, wrongIdentity))).status,
		).toBe(401);
		expect((await app(channel).request('/events', await eventInit(wrongSubscription))).status).toBe(
			403,
		);
		expect(workspaceEvents).not.toHaveBeenCalled();
	});

	it('publishes only configured routes when one surface is omitted', () => {
		const interactions = endpointChannel(() => undefined);
		const events = workspaceChannel(() => undefined);

		expect(interactions.routes.map((route) => route.path)).toEqual(['/interactions']);
		expect(events.routes.map((route) => route.path)).toEqual(['/events']);
	});

	it('round trips canonical conversation keys when space and thread match', () => {
		const channel = endpointChannel(() => undefined);
		const reference = {
			space: 'spaces/canonical-space',
			thread: 'spaces/canonical-space/threads/canonical-thread',
		};
		const key = channel.conversationKey(reference);

		expect(channel.parseConversationKey(key)).toEqual(reference);
		expect(channel.conversationKey({ ...reference, spaceType: 'FUTURE_SPACE_TYPE' })).toBe(key);
	});

	it('rejects conversation keys when the thread belongs to another space', () => {
		const channel = endpointChannel(() => undefined);
		const mismatched = {
			space: 'spaces/one',
			thread: 'spaces/two/threads/thread',
		};
		const encoded = 'google-chat:v1:spaces%2Fone:spaces%2Ftwo%2Fthreads%2Fthread';

		expect(() => channel.conversationKey(mismatched)).toThrow(InvalidGoogleChatInputError);
		expect(() => channel.parseConversationKey(encoded)).toThrow(
			InvalidGoogleChatConversationKeyError,
		);
	});
});

function app(channel: GoogleChatChannel): Hono {
	const hono = new Hono();
	for (const route of channel.routes) hono.on(route.method, route.path, route.handler);
	return hono;
}

function endpointChannel(
	handler: Parameters<typeof createGoogleChatChannel>[0]['interactions'] extends infer T
		? T extends { handler: infer H }
			? H
			: never
		: never,
	bodyLimit?: number,
): GoogleChatChannel {
	return createGoogleChatChannel({
		fetch: keyFetcher(),
		...(bodyLimit === undefined ? {} : { bodyLimit }),
		interactions: {
			authentication: { type: 'endpoint-url', audience: ENDPOINT_AUDIENCE, jwksUrl: JWKS_URL },
			handler,
		},
	});
}

function workspaceChannel(
	handler: NonNullable<Parameters<typeof createGoogleChatChannel>[0]['workspaceEvents']>['handler'],
): GoogleChatChannel {
	return createGoogleChatChannel({
		fetch: keyFetcher(),
		workspaceEvents: {
			authentication: {
				subscription: PUBSUB_SUBSCRIPTION,
				audience: PUBSUB_AUDIENCE,
				serviceAccountEmail: PUBSUB_IDENTITY,
				jwksUrl: JWKS_URL,
			},
			handler,
		},
	});
}

function keyFetcher() {
	return vi.fn(async () =>
		Response.json({
			keys: [{ ...oidcJwk, kid: 'synthetic-google-key', alg: 'RS256', use: 'sig' }],
		}),
	);
}

async function interactionInit(payload: unknown): Promise<RequestInit> {
	const token = await signOidcToken(ENDPOINT_AUDIENCE, CHAT_IDENTITY);
	return requestWithToken(payload, token);
}

async function eventInit(delivery: unknown): Promise<RequestInit> {
	const token = await signOidcToken(PUBSUB_AUDIENCE, PUBSUB_IDENTITY);
	return requestWithToken(delivery, token);
}

function requestWithToken(body: unknown, token: string): RequestInit {
	return {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify(body),
	};
}

async function signOidcToken(
	audience: string,
	email: string,
	overrides: { issuer?: string; expirationTime?: number; kid?: string } = {},
): Promise<string> {
	return new SignJWT({ email, email_verified: true })
		.setProtectedHeader({ alg: 'RS256', kid: overrides.kid ?? 'synthetic-google-key' })
		.setIssuer(overrides.issuer ?? 'https://accounts.google.com')
		.setAudience(audience)
		.setIssuedAt()
		.setExpirationTime(overrides.expirationTime ?? '5m')
		.sign(oidcPrivateKey);
}

function pubsubDelivery(options: { eventType: string; subject: string; data: unknown }) {
	return {
		message: {
			attributes: {
				'ce-datacontenttype': 'application/json',
				'ce-id': 'workspace-event-88',
				'ce-source': '//workspaceevents.googleapis.com/subscriptions/subscription-23',
				'ce-specversion': '1.0',
				'ce-subject': options.subject,
				'ce-time': '2026-06-13T18:07:00Z',
				'ce-type': options.eventType,
			},
			data: btoa(JSON.stringify(options.data)),
			messageId: 'pubsub-message-100',
			publishTime: '2026-06-13T18:07:01Z',
		},
		subscription: PUBSUB_SUBSCRIPTION,
	} as Record<string, any>;
}
