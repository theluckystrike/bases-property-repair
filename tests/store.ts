import type { Store } from '../src/repair';

/** An in-memory Store that logs each create and write, so tests can check the sequence. */
export function memoryStore(initial: Record<string, string>): Store & { files: Record<string, string>; log: string[]; folders: Set<string> } {
	const files: Record<string, string> = { ...initial };
	const log: string[] = [];
	const folders = new Set<string>();
	return {
		files,
		log,
		folders,
		read: async (path) => files[path] ?? null,
		exists: (path) => path in files,
		ensureFolder: async (path) => {
			folders.add(path);
		},
		create: async (path, text) => {
			if (path in files) throw new Error(`exists ${path}`);
			files[path] = text;
			log.push(`create ${path}`);
		},
		process: async (path, fn) => {
			const cur = files[path];
			if (cur === undefined) throw new Error(`missing ${path}`);
			const next = fn(cur);
			if (next !== cur) log.push(`write ${path}`);
			files[path] = next;
		},
	};
}
