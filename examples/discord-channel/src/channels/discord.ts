import { REST } from '@discordjs/rest';
import {
	type APIInteraction,
	type APIInteractionResponse,
	createDiscordChannel,
	type DiscordDestinationRef,
} from '@flue/discord';
import { defineTool, dispatch } from '@flue/runtime';
import assistant from '../agents/assistant.ts';

export const client = new REST({ version: '10' }).setToken(requiredEnv('DISCORD_BOT_TOKEN'));

export const channel = createDiscordChannel({
	publicKey: requiredEnv('DISCORD_PUBLIC_KEY'),

	// Path: /channels/discord/interactions
	async interactions({ interaction }) {
		if (interaction.type !== 2 || interaction.data.name !== 'ask') {
			return {
				type: 4,
				data: { content: 'Unsupported interaction.', flags: 64 },
			} satisfies APIInteractionResponse;
		}

		const destination = destinationFromInteraction(interaction);
		if (!destination || destination.type === 'private') {
			return {
				type: 4,
				data: { content: 'Unsupported interaction.', flags: 64 },
			} satisfies APIInteractionResponse;
		}

		await dispatch(assistant, {
			id: channel.conversationKey(destination),
			input: {
				type: 'discord.command.ask',
				interactionId: interaction.id,
				data: interaction.data,
			},
		});
		return {
			type: 4,
			data: { content: 'Your request was accepted.', flags: 64 },
		} satisfies APIInteractionResponse;
	},
});

export function postMessage(ref: DiscordDestinationRef) {
	return defineTool({
		name: 'post_discord_message',
		description: 'Post a message to the Discord destination bound to this agent.',
		parameters: {
			type: 'object',
			properties: {
				content: { type: 'string', minLength: 1 },
			},
			required: ['content'],
			additionalProperties: false,
		},
		async execute({ content }) {
			const result = (await client.post(`/channels/${ref.channelId}/messages`, {
				body: { content },
			})) as { id?: string };
			return JSON.stringify({ messageId: result.id });
		},
	});
}

function destinationFromInteraction(
	interaction: APIInteraction,
): DiscordDestinationRef | undefined {
	const channelId = interaction.channel?.id ?? interaction.channel_id;
	if (!channelId) return undefined;
	if (interaction.guild_id) {
		return { type: 'guild', guildId: interaction.guild_id, channelId };
	}
	if (interaction.context === 2 || interaction.channel?.type === 3) {
		return { type: 'private', channelId };
	}
	if (interaction.context === 1 || interaction.channel?.type === 1) {
		return { type: 'dm', channelId };
	}
	return undefined;
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required.`);
	return value;
}
