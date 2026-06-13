# Discord channel example

Example of verified Discord HTTP interactions, typed immediate responses,
explicit dispatch routing, destination identity, and safe pre-scoped bot-token
tools.

`DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID`, and `DISCORD_BOT_TOKEN` are required when the built application starts. Builds and type checks do not require live credentials.

The channel module imports the agent and the agent imports the channel. This cycle is safe only because dispatch and tool access are deferred into handlers and the agent initializer. A routing module that imports both can avoid the cycle.

Conversation keys validate syntax, not authorization. This agent is intentionally dispatch-only. Any direct agent route must independently authorize the caller-selected instance id before deriving outbound tools from it.

The example supports guild channels, guild threads, and bot DMs. A bot-token
post is a new ordinary message, not an interaction follow-up or an ephemeral
response. Discord Gateway events and deferred interaction-token replies are not
part of this package's v1 scope. A public HTTPS tunnel is required for local
webhook development.
