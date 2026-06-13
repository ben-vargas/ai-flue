export class DuplicateDiscordHandlerError extends Error {
	readonly kind: 'command' | 'component' | 'modal';
	readonly key: string;

	constructor(kind: 'command' | 'component' | 'modal', key: string) {
		super(`A Discord ${kind} handler is already registered for "${key}".`);
		this.name = 'DuplicateDiscordHandlerError';
		this.kind = kind;
		this.key = key;
	}
}

export class InvalidDiscordConversationKeyError extends Error {
	constructor() {
		super('Invalid Discord conversation key.');
		this.name = 'InvalidDiscordConversationKeyError';
	}
}

export class InvalidDiscordInputError extends TypeError {
	readonly field: string;

	constructor(field: string) {
		super(`Invalid Discord ${field}.`);
		this.name = 'InvalidDiscordInputError';
		this.field = field;
	}
}

export interface DiscordApiErrorOptions {
	status: number;
	code: string;
	requestId?: string;
	responseMessage?: string;
	retryAfterSeconds?: number;
	global?: boolean;
	rateLimitScope?: string;
	rateLimitBucket?: string;
}

export class DiscordApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly requestId?: string;
	readonly responseMessage?: string;
	readonly retryAfterSeconds?: number;
	readonly global?: boolean;
	readonly rateLimitScope?: string;
	readonly rateLimitBucket?: string;

	constructor(options: DiscordApiErrorOptions) {
		super(`Discord API request failed: ${options.code}.`);
		this.name = 'DiscordApiError';
		this.status = options.status;
		this.code = options.code;
		this.requestId = options.requestId;
		this.responseMessage = options.responseMessage;
		this.retryAfterSeconds = options.retryAfterSeconds;
		this.global = options.global;
		this.rateLimitScope = options.rateLimitScope;
		this.rateLimitBucket = options.rateLimitBucket;
	}
}

export class DiscordRateLimitError extends DiscordApiError {
	constructor(options: DiscordApiErrorOptions) {
		super(options);
		this.name = 'DiscordRateLimitError';
	}
}

export class DiscordTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`Discord API request timed out after ${timeoutMs}ms.`);
		this.name = 'DiscordTimeoutError';
		this.timeoutMs = timeoutMs;
	}
}
