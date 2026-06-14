import { REST } from '@discordjs/rest';
import { describe, expect, it, vi } from 'vitest';

describe('Discord REST client', () => {
	it('constructs an authenticated message request when executed in Node', async () => {
		const fetch = vi.fn(async (input: RequestInfo | URL) => {
			if (String(input) !== 'https://discord.com/api/v10/channels/C1/messages') {
				throw new Error(`Unexpected network request: ${String(input)}`);
			}
			return Response.json({ id: 'M1', channel_id: 'C1', content: 'Hello from Node.' });
		});
		const client = new REST({ version: '10', makeRequest: fetch }).setToken('discord-test-token');

		try {
			const result = (await client.post('/channels/C1/messages', {
				body: { content: 'Hello from Node.' },
			})) as { id?: string };

			expect(result.id).toBe('M1');
			expect(fetch).toHaveBeenCalledOnce();
			const [, init] = fetch.mock.calls[0] ?? [];
			expect(init?.method).toBe('POST');
			expect(new Headers(init?.headers).get('authorization')).toBe('Bot discord-test-token');
			expect(JSON.parse(String(init?.body))).toEqual({ content: 'Hello from Node.' });
		} finally {
			client.clearHashSweeper();
			client.clearHandlerSweeper();
		}
	});
});
