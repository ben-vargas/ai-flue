import type {
	DiscordCommandData,
	DiscordCommandResponse,
	DiscordComponentData,
	DiscordComponentResponse,
	DiscordDestinationRef,
	DiscordInteractionEnvelope,
	DiscordInteractionHandler,
	DiscordModalData,
	DiscordModalResponse,
	DiscordRouteHandler,
} from './index.ts';

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const DEFAULT_HANDLER_TIMEOUT_MS = 2_500;
const GUILD_CHANNEL_TYPES = new Set([0, 5]);
const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);
const encoder = new TextEncoder();

interface DiscordInteractionsHandlerOptions {
	publicKey: Uint8Array;
	applicationId: string;
	bodyLimit?: number;
	handlerTimeoutMs?: number;
	getCommandHandler(
		name: string,
	):
		| DiscordInteractionHandler<
				DiscordInteractionEnvelope<DiscordCommandData>,
				DiscordCommandResponse
		  >
		| undefined;
	getComponentHandler(
		customId: string,
	):
		| DiscordInteractionHandler<
				DiscordInteractionEnvelope<DiscordComponentData>,
				DiscordComponentResponse
		  >
		| undefined;
	getModalHandler(
		customId: string,
	):
		| DiscordInteractionHandler<
				DiscordInteractionEnvelope<DiscordModalData>,
				DiscordModalResponse
		  >
		| undefined;
}

export function createDiscordInteractionsHandler(
	options: DiscordInteractionsHandlerOptions,
): DiscordRouteHandler {
	const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
	const handlerTimeoutMs = options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
	if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
		throw new TypeError('Discord route bodyLimit must be a positive integer.');
	}
	if (!Number.isSafeInteger(handlerTimeoutMs) || handlerTimeoutMs <= 0) {
		throw new TypeError('Discord route handlerTimeoutMs must be a positive integer.');
	}
	if (handlerTimeoutMs > DEFAULT_HANDLER_TIMEOUT_MS) {
		throw new TypeError('Discord route handlerTimeoutMs must not exceed 2500ms.');
	}

	return async (request) => {
		const pathname = new URL(request.url).pathname;
		if (pathname !== '/') return response(404);
		if (request.method !== 'POST') {
			return new Response(null, { status: 405, headers: { Allow: 'POST' } });
		}
		const mediaType = request.headers
			.get('content-type')
			?.split(';', 1)[0]
			?.trim()
			.toLowerCase();
		if (mediaType !== 'application/json') return response(415);

		const contentLength = request.headers.get('content-length');
		if (contentLength !== null) {
			if (!/^\d+$/.test(contentLength)) return response(400);
			if (Number(contentLength) > bodyLimit) return response(413);
		}

		let body: Uint8Array | undefined;
		try {
			body = await readBody(request, bodyLimit);
		} catch {
			return response(400);
		}
		if (!body) return response(413);

		const signature = parseHex(request.headers.get('x-signature-ed25519'), 64);
		const timestamp = request.headers.get('x-signature-timestamp');
		if (
			!signature ||
			timestamp === null ||
			timestamp.length === 0 ||
			!(await verifySignature(options.publicKey, timestamp, body, signature))
		) {
			return response(401);
		}

		const raw = parseJson(body);
		if (!isRecord(raw)) return response(400);
		const type = readInteger(raw, 'type');
		if (type === 1) return Response.json({ type: 1 });

		const applicationId = readString(raw, 'application_id');
		if (!applicationId) return response(400);
		if (applicationId !== options.applicationId) return response(403);

		if (type !== 2 && type !== 3 && type !== 5) return response(404);

		const common = normalizeCommon(raw, applicationId);
		if (!common) return response(400);

		if (type === 2) {
			const data = normalizeCommandData(raw);
			if (!data) return response(400);
			const handler = options.getCommandHandler(data.name);
			if (!handler) return response(404);
			const outcome = await runHandler(
				() => handler({ ...common, data, raw }),
				handlerTimeoutMs,
			);
			return serializeOutcome(outcome, 'command');
		}

		if (type === 3) {
			const data = normalizeComponentData(raw);
			if (!data) return response(400);
			const handler = options.getComponentHandler(data.customId);
			if (!handler) return response(404);
			const outcome = await runHandler(
				() => handler({ ...common, data, raw }),
				handlerTimeoutMs,
			);
			return serializeOutcome(outcome, 'component');
		}

		const data = normalizeModalData(raw);
		if (!data) return response(400);
		const handler = options.getModalHandler(data.customId);
		if (!handler) return response(404);
		const outcome = await runHandler(
			() => handler({ ...common, data, raw }),
			handlerTimeoutMs,
		);
		return serializeOutcome(outcome, 'modal');
	};
}

function normalizeCommon(
	raw: Record<string, unknown>,
	applicationId: string,
): Omit<DiscordInteractionEnvelope<never>, 'data' | 'raw'> | undefined {
	const id = readString(raw, 'id');
	const token = readString(raw, 'token');
	const destination = normalizeDestination(raw);
	if (!id || !token || !destination) return undefined;
	return { id, applicationId, token, destination };
}

function normalizeDestination(raw: Record<string, unknown>): DiscordDestinationRef | undefined {
	const channelId = readString(raw, 'channel_id');
	const guildId = readOptionalString(raw, 'guild_id');
	const context = readInteger(raw, 'context');
	const channel = readRecord(raw, 'channel');
	const channelType = channel && readInteger(channel, 'type');
	const nestedChannelId = channel && readString(channel, 'id');
	if (!channelId) return undefined;
	if (!nestedChannelId || nestedChannelId !== channelId) return undefined;

	if (guildId) {
		if (context !== undefined && context !== 0) return undefined;
		if (channelType === undefined) return undefined;
		if (!GUILD_CHANNEL_TYPES.has(channelType) && !THREAD_CHANNEL_TYPES.has(channelType)) {
			return undefined;
		}
		return {
			type: 'guild',
			guildId,
			channelId,
			channelKind: channelType !== undefined && THREAD_CHANNEL_TYPES.has(channelType)
				? 'thread'
				: 'channel',
		};
	}

	if (context !== undefined && context !== 1) return undefined;
	if (channelType !== 1) return undefined;
	return { type: 'dm', channelId };
}

function normalizeCommandData(raw: Record<string, unknown>): DiscordCommandData | undefined {
	const data = readRecord(raw, 'data');
	const name = data && readString(data, 'name');
	const commandType = data && readInteger(data, 'type');
	if (!data || !name || commandType !== 1) return undefined;
	const options = data.options;
	if (options !== undefined && !Array.isArray(options)) return undefined;
	return { name, options: options ?? [] };
}

function normalizeComponentData(raw: Record<string, unknown>): DiscordComponentData | undefined {
	const data = readRecord(raw, 'data');
	const customId = data && readString(data, 'custom_id');
	const componentType = data && readInteger(data, 'component_type');
	if (!data || !customId || componentType !== 2) return undefined;
	const values = data.values;
	if (
		values !== undefined &&
		(!Array.isArray(values) || values.some((value) => typeof value !== 'string'))
	) {
		return undefined;
	}
	return { customId, componentType, ...(values === undefined ? {} : { values }) };
}

function normalizeModalData(raw: Record<string, unknown>): DiscordModalData | undefined {
	const data = readRecord(raw, 'data');
	const customId = data && readString(data, 'custom_id');
	const components = data?.components;
	if (!data || !customId || !Array.isArray(components)) return undefined;
	return { customId, components, fields: collectModalFields(components) };
}

function collectModalFields(components: readonly unknown[]): Array<{
	customId: string;
	type: number;
	value?: string;
}> {
	const fields: Array<{ customId: string; type: number; value?: string }> = [];
	for (const component of components) {
		if (!isRecord(component)) continue;
		const customId = readString(component, 'custom_id');
		const type = readInteger(component, 'type');
		const value = readAnyString(component, 'value');
		if (customId && type !== undefined) {
			fields.push({ customId, type, ...(value === undefined ? {} : { value }) });
		}
		const children = component.components;
		if (Array.isArray(children)) fields.push(...collectModalFields(children));
		if (isRecord(component.component)) fields.push(...collectModalFields([component.component]));
	}
	return fields;
}

type HandlerOutcome<T> =
	| { type: 'success'; value: T }
	| { type: 'failure' }
	| { type: 'timeout' };

async function runHandler<T>(
	handler: () => T | Promise<T>,
	timeoutMs: number,
): Promise<HandlerOutcome<T>> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const handlerPromise = Promise.resolve()
		.then(handler)
		.then(
			(value): HandlerOutcome<T> => ({ type: 'success', value }),
			(): HandlerOutcome<T> => ({ type: 'failure' }),
		);
	const timeoutPromise = new Promise<HandlerOutcome<T>>((resolve) => {
		timeout = setTimeout(() => resolve({ type: 'timeout' }), timeoutMs);
	});
	const outcome = await Promise.race([handlerPromise, timeoutPromise]);
	if (timeout !== undefined) clearTimeout(timeout);
	return outcome;
}

function serializeOutcome(
	outcome: HandlerOutcome<unknown>,
	kind: 'command' | 'component' | 'modal',
): Response {
	if (outcome.type !== 'success') return response(500);
	const serialized = serializeInteractionResponse(outcome.value, kind);
	return serialized ? Response.json(serialized) : response(500);
}

function serializeInteractionResponse(
	value: unknown,
	kind: 'command' | 'component' | 'modal',
): Record<string, unknown> | undefined {
	if (!isRecord(value)) return undefined;
	if (value.type === 'message') {
		const message = serializeMessage(value.message);
		if (!message || !isOptionalBoolean(value.ephemeral)) return undefined;
		return {
			type: 4,
			data: {
				...message,
				allowed_mentions: message.allowed_mentions ?? { parse: [] },
				...(value.ephemeral === true ? { flags: 64 } : {}),
			},
		};
	}
	if (value.type === 'update_message') {
		if (kind === 'command') return undefined;
		const message = serializeMessage(value.message);
		return message
			? {
					type: 7,
					data: {
						...message,
						allowed_mentions: message.allowed_mentions ?? { parse: [] },
					},
				}
			: undefined;
	}
	if (value.type === 'modal') {
		if (kind === 'modal') return undefined;
		const customId = value.customId;
		const title = value.title;
		const components = value.components;
		if (
			!isBoundedString(customId, 1, 100) ||
			!isBoundedString(title, 1, 45) ||
			!isValidModalComponents(components)
		) {
			return undefined;
		}
		return {
			type: 9,
			data: { custom_id: customId, title, components: serializeComponents(components) },
		};
	}
	return undefined;
}

function serializeMessage(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value) || !isBoundedString(value.content, 1, 2_000)) {
		return undefined;
	}
	if (
		value.components !== undefined &&
		(!Array.isArray(value.components) || !isValidMessageComponents(value.components))
	) {
		return undefined;
	}
	if (value.allowedMentions !== undefined && !isAllowedMentions(value.allowedMentions)) {
		return undefined;
	}
	return {
		content: value.content,
		...(value.components === undefined
			? {}
			: { components: serializeComponents(value.components) }),
		...(value.allowedMentions === undefined
			? {}
			: {
					allowed_mentions: {
						...(value.allowedMentions.parse === undefined
							? {}
							: { parse: value.allowedMentions.parse }),
						...(value.allowedMentions.users === undefined
							? {}
							: { users: value.allowedMentions.users }),
						...(value.allowedMentions.roles === undefined
							? {}
							: { roles: value.allowedMentions.roles }),
					},
				}),
	};
}

function isValidMessageComponents(value: readonly unknown[]): boolean {
	if (value.length < 1 || value.length > 5) return false;
	return value.every((row) => {
		if (!isRecord(row) || row.type !== 1 || !Array.isArray(row.components)) return false;
		if (row.components.length < 1 || row.components.length > 5) return false;
		return row.components.every(
			(button) =>
				isRecord(button) &&
				button.type === 2 &&
				typeof button.style === 'number' &&
				Number.isSafeInteger(button.style) &&
				button.style >= 1 &&
				button.style <= 4 &&
				isBoundedString(button.customId, 1, 100) &&
				isBoundedString(button.label, 1, 80),
		);
	});
}

function isValidModalComponents(value: unknown): value is readonly unknown[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 5) return false;
	return value.every((label) => {
		if (
			!isRecord(label) ||
			label.type !== 18 ||
			!isBoundedString(label.label, 1, 45) ||
			(label.description !== undefined && !isBoundedString(label.description, 1, 100)) ||
			!isRecord(label.component)
		) {
			return false;
		}
		const input = label.component;
		if (
			input.type !== 4 ||
			!isBoundedString(input.customId, 1, 100) ||
			(input.style !== 1 && input.style !== 2) ||
			(input.placeholder !== undefined && !isBoundedString(input.placeholder, 1, 100)) ||
			(input.required !== undefined && typeof input.required !== 'boolean')
		) {
			return false;
		}
		const minLength = readOptionalBoundedInteger(input.minLength, 0, 4_000);
		const maxLength = readOptionalBoundedInteger(input.maxLength, 1, 4_000);
		if (input.minLength !== undefined && minLength === undefined) return false;
		if (input.maxLength !== undefined && maxLength === undefined) return false;
		return minLength === undefined || maxLength === undefined || minLength <= maxLength;
	});
}

function readOptionalBoundedInteger(
	value: unknown,
	minimum: number,
	maximum: number,
): number | undefined {
	return typeof value === 'number' &&
		Number.isSafeInteger(value) &&
		value >= minimum &&
		value <= maximum
		? value
		: undefined;
}

function isBoundedString(value: unknown, minimum: number, maximum: number): value is string {
	return typeof value === 'string' && value.length >= minimum && value.length <= maximum;
}

function serializeComponents(components: readonly unknown[]): readonly unknown[] {
	return components.map((component) => serializeComponent(component));
}

function serializeComponent(value: unknown): unknown {
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [
			componentWireKey(key),
			(key === 'components' && Array.isArray(item)) || (key === 'component' && isRecord(item))
				? key === 'components'
					? serializeComponents(item as readonly unknown[])
					: serializeComponent(item)
				: item,
		]),
	);
}

function componentWireKey(key: string): string {
	if (key === 'customId') return 'custom_id';
	if (key === 'minLength') return 'min_length';
	if (key === 'maxLength') return 'max_length';
	return key;
}

function isAllowedMentions(value: unknown): value is {
	parse?: Array<'users' | 'roles' | 'everyone'>;
	users?: string[];
	roles?: string[];
} {
	if (!isRecord(value)) return false;
	if (
		value.parse !== undefined &&
		(!Array.isArray(value.parse) ||
			value.parse.some(
				(item) => item !== 'users' && item !== 'roles' && item !== 'everyone',
			))
	) {
		return false;
	}
	if (!isOptionalStringArray(value.users) || !isOptionalStringArray(value.roles)) return false;
	if (value.parse?.includes('users') && value.users !== undefined) return false;
	if (value.parse?.includes('roles') && value.roles !== undefined) return false;
	return true;
}

function isOptionalStringArray(value: unknown): boolean {
	return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
}

function isOptionalBoolean(value: unknown): boolean {
	return value === undefined || typeof value === 'boolean';
}

async function readBody(request: Request, bodyLimit: number): Promise<Uint8Array | undefined> {
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > bodyLimit) {
				void reader.cancel();
				return undefined;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

function parseHex(value: string | null, byteLength: number): Uint8Array | undefined {
	const expression = new RegExp(`^[0-9a-fA-F]{${byteLength * 2}}$`);
	if (!expression.test(value ?? '')) return undefined;
	const bytes = new Uint8Array(byteLength);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt((value ?? '').slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

async function verifySignature(
	publicKey: Uint8Array,
	timestamp: string,
	body: Uint8Array,
	signature: Uint8Array,
): Promise<boolean> {
	try {
		const prefix = encoder.encode(timestamp);
		const signed = new Uint8Array(prefix.byteLength + body.byteLength);
		signed.set(prefix);
		signed.set(body, prefix.byteLength);
		const key = await crypto.subtle.importKey(
			'raw',
			toArrayBuffer(publicKey),
			{ name: 'Ed25519' },
			false,
			['verify'],
		);
		return crypto.subtle.verify(
			'Ed25519',
			key,
			toArrayBuffer(signature),
			toArrayBuffer(signed),
		);
	} catch {
		return false;
	}
}

function parseJson(body: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
	} catch {
		return undefined;
	}
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.slice().buffer;
}

function response(status: number): Response {
	return new Response(null, { status });
}

function readRecord(
	value: Record<string, unknown>,
	key: string,
): Record<string, unknown> | undefined {
	const field = value[key];
	return isRecord(field) ? field : undefined;
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
	const field = value[key];
	return typeof field === 'string' && field.length > 0 ? field : undefined;
}

function readOptionalString(value: Record<string, unknown>, key: string): string | undefined {
	return readString(value, key);
}

function readAnyString(value: Record<string, unknown>, key: string): string | undefined {
	const field = value[key];
	return typeof field === 'string' ? field : undefined;
}

function readInteger(value: Record<string, unknown>, key: string): number | undefined {
	const field = value[key];
	return typeof field === 'number' && Number.isSafeInteger(field) ? field : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
