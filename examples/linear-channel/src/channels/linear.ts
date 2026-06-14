import {
	createLinearChannel,
	type LinearConversationRef,
	type LinearWebhookPayload,
} from '@flue/linear';
import { defineTool, dispatch } from '@flue/runtime';
import { LinearClient } from '@linear/sdk';
import type {
	AgentSessionEventWebhookPayload,
	EntityWebhookPayloadWithCommentData,
} from '@linear/sdk/webhooks';
import assistant from '../agents/assistant.ts';

const organizationId = optionalEnv('LINEAR_ORGANIZATION_ID');
const webhookId = optionalEnv('LINEAR_WEBHOOK_ID');

export const client = new LinearClient(linearCredentials());

export const channel = createLinearChannel({
	webhookSecret: requiredEnv('LINEAR_WEBHOOK_SECRET'),
	...(organizationId === undefined ? {} : { organizationId }),
	...(webhookId === undefined ? {} : { webhookId }),

	// Path: /channels/linear/webhook
	async webhook({ payload, deliveryId }) {
		if (isCommentEvent(payload)) {
			const comment = payload.data;
			if (payload.action !== 'create' || !comment.issueId) return;
			await dispatch(assistant, {
				id: channel.conversationKey({
					type: 'issue',
					organizationId: payload.organizationId,
					issueId: comment.issueId,
					...(comment.parentId ? { threadCommentId: comment.parentId } : {}),
				}),
				input: {
					type: 'linear.comment.created',
					deliveryId,
					actor: payload.actor,
					comment,
				},
			});
			return;
		}

		if (isAgentSessionEvent(payload)) {
			await dispatch(assistant, {
				id: channel.conversationKey({
					type: 'agent-session',
					organizationId: payload.organizationId,
					agentSessionId: payload.agentSession.id,
				}),
				input: {
					type: `linear.agent_session.${payload.action}`,
					deliveryId,
					promptContext: payload.promptContext,
					activity: payload.agentActivity,
					session: payload.agentSession,
				},
			});
		}
	},
});

// Narrow Linear's native union to the surfaces this app handles. The union's
// catch-all member keeps `type` widened, so a literal check alone does not
// narrow; combine it with the discriminating nested field.
function isCommentEvent(
	payload: LinearWebhookPayload,
): payload is EntityWebhookPayloadWithCommentData {
	return payload.type === 'Comment' && 'body' in payload.data;
}

function isAgentSessionEvent(
	payload: LinearWebhookPayload,
): payload is AgentSessionEventWebhookPayload {
	return payload.type === 'AgentSessionEvent' && 'agentSession' in payload;
}

export function postMessage(ref: LinearConversationRef) {
	return defineTool({
		name: 'post_linear_message',
		description: 'Post a message to the Linear conversation bound to this agent.',
		parameters: {
			type: 'object',
			properties: {
				text: { type: 'string', minLength: 1 },
			},
			required: ['text'],
			additionalProperties: false,
		},
		async execute({ text }) {
			if (ref.type === 'agent-session') {
				const result = await client.createAgentActivity({
					agentSessionId: ref.agentSessionId,
					content: { type: 'response', body: text },
				});
				return JSON.stringify({ success: result.success });
			}
			const result = await client.createComment({
				issueId: ref.issueId,
				...(ref.threadCommentId === undefined ? {} : { parentId: ref.threadCommentId }),
				body: text,
			});
			return JSON.stringify({ success: result.success, commentId: result.commentId });
		},
	});
}

function linearCredentials(): { apiKey: string } | { accessToken: string } {
	const apiKey = optionalEnv('LINEAR_API_KEY');
	const accessToken = optionalEnv('LINEAR_ACCESS_TOKEN');
	if (apiKey && accessToken) {
		throw new Error('Set LINEAR_API_KEY or LINEAR_ACCESS_TOKEN, not both.');
	}
	if (accessToken) return { accessToken };
	if (apiKey) return { apiKey };
	throw new Error('LINEAR_API_KEY or LINEAR_ACCESS_TOKEN is required.');
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required.`);
	return value;
}

function optionalEnv(name: string): string | undefined {
	return process.env[name] || undefined;
}
