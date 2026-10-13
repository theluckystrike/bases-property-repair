import { describe, expect, it } from 'vitest';
import { applyPlans, planBase, restorePath, textHash } from '../src/repair';
import { memoryStore } from './store';

const TEXT = 'views:\n  - type: table\n    order:\n      - status\n';

describe('applyPlans guards', () => {
	it('stops the write when the file changes between the restore copy and the write', async () => {
		const store = memoryStore({ 'a.base': TEXT });
		const plan = planBase('a.base', TEXT, { status: 'state' });
		const create = store.create;
		store.create = async (path, text) => {
			await create(path, text);
			store.files['a.base'] = TEXT + '# sync edit\n';
		};
		const [r] = await applyPlans(store, [plan], new Set(['a.base']), 'R', 's');
		expect(r).toMatchObject({ status: 'stale', copy: 'R/a s.base' });
		expect(store.files['a.base']).toBe(TEXT + '# sync edit\n');
		expect(store.log).toEqual(['create R/a s.base']);
	});

	it('reports a file that is gone and an error from the store, and writes nothing', async () => {
		const store = memoryStore({ 'a.base': TEXT, 'b.base': TEXT });
		const plans = [planBase('a.base', TEXT, { status: 'state' }), planBase('b.base', TEXT, { status: 'state' })];
		delete store.files['a.base'];
		store.create = async () => {
			throw new Error('disk full');
		};
		const results = await applyPlans(store, plans, new Set(['a.base', 'b.base']), 'R', 's');
		expect(results.map((r) => [r.path, r.status, r.message])).toEqual([
			['a.base', 'stale', 'The file is gone. Not written.'],
			['b.base', 'error', 'Not written: disk full'],
		]);
		expect(store.files['b.base']).toBe(TEXT);
	});

	it('skips plans with no change and plans that are not checked', async () => {
		const store = memoryStore({ 'a.base': TEXT, 'b.base': 'views: []\n' });
		const plans = [planBase('a.base', TEXT, { status: 'state' }), planBase('b.base', 'views: []\n', { status: 'state' })];
		expect(await applyPlans(store, plans, new Set(['b.base']), 'R', 's')).toEqual([]);
		expect(store.log).toEqual([]);
	});

	it('numbers restore copy names that are taken, and hashes text', () => {
		const taken = new Set(['R/a s.base', 'R/a s 2.base']);
		expect(restorePath({ exists: (p) => taken.has(p) }, 'R', 'x/a.base', 's')).toBe('R/a s 3.base');
		expect(textHash('abc')).toBe(textHash('abc'));
		expect(textHash('abc')).not.toBe(textHash('abd'));
		expect(textHash('')).toMatch(/^[0-9a-f]{8}$/);
	});
});
