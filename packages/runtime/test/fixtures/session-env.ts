import type { SessionEnv } from '../../src/types.ts';

export function createNoopSessionEnv({
	cwd = '/repo',
	...overrides
}: Partial<SessionEnv> = {}): SessionEnv {
	const resolvePath = (path: string) =>
		normalizePath(path.startsWith('/') ? path : `${cwd}/${path}`);

	return {
		cwd,
		resolvePath,
		exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
		readFile: async () => '',
		readFileBuffer: async () => new Uint8Array(),
		writeFile: async () => {},
		stat: async () => ({
			isFile: false,
			isDirectory: false,
			isSymbolicLink: false,
			size: 0,
			mtime: new Date(0),
		}),
		readdir: async () => [],
		exists: async () => false,
		mkdir: async () => {},
		rm: async () => {},
		...overrides,
	};
}

function normalizePath(path: string): string {
	const segments: string[] = [];
	for (const segment of path.split('/')) {
		if (!segment || segment === '.') continue;
		if (segment === '..') segments.pop();
		else segments.push(segment);
	}
	return `/${segments.join('/')}`;
}
