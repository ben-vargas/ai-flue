# `@flue/discord`

First-party Discord HTTP interactions and outbound-tool integration for Flue.

```ts
import { createDiscordChannel } from '@flue/discord';

export const discord = createDiscordChannel({
	publicKey: process.env.DISCORD_PUBLIC_KEY!,
	applicationId: process.env.DISCORD_APPLICATION_ID!,
	botToken: process.env.DISCORD_BOT_TOKEN!,
});

discord.onCommand('ask', async (interaction) => {
	await admitWork(interaction);
	return {
		type: 'message',
		message: { content: 'Your request was accepted.' },
		ephemeral: true,
	};
});

app.mount('/webhooks/discord', discord.routes.interactions());
```

The interactions route verifies `X-Signature-Ed25519` over the exact
`X-Signature-Timestamp` plus raw request bytes, handles PING/PONG internally,
checks the signed `application_id`, and waits for the registered handler before
returning an immediate response. Handler deadlines are capped at 2.5 seconds.
Discord does not provide dependable redelivery when an interaction fails or
times out.

Supported destinations are guild channels, guild threads, and bot DMs. Private
channel/group-DM interactions are rejected before handlers run because a bot
token cannot be assumed to have access. Bot-token posts are ordinary new
messages, not interaction follow-ups, edits, or guaranteed ephemeral replies.

The package is stateless and does not deduplicate interaction ids. Conversation
keys are identifiers, not authorization capabilities. Message tools bind the
destination in trusted application code and set `allowed_mentions.parse` to an
empty array unless mention classes are explicitly enabled when the tool is
created.

Discord's timestamp is authenticated as part of the signature but v1 does not
apply an invented freshness window. Identical valid interactions can be
replayed, so applications that require unique admission must claim interaction
ids in their own durable storage.

Interaction envelopes include the provider interaction token and complete raw
payload for handler-level protocol access. Both are sensitive capabilities:
never place them in dispatched input, logs, model-visible context, or durable
session data. Interaction-token follow-ups are intentionally not exposed as
agent tools.

Discord Gateway events and interaction-token follow-ups are outside v1. Local
development requires a public HTTPS tunnel for Discord's interactions endpoint.
v1 command ingress accepts chat-input commands, component ingress accepts
buttons, and modal responses use Label components containing text inputs.
