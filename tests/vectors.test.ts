import { describe, expect, it } from 'vitest';
import { parseYaml } from 'obsidian';
import vectors from './vectors/bases-property-repair.json';
import { rewriteExpression, type KeyMap } from '../src/expr';
import { applyPlans, planBase, validateMap, type FilePlan } from '../src/repair';
import { memoryStore } from './store';

interface Case {
	name: string;
	function: 'planBase' | 'rewriteExpression' | 'applyScenario' | 'validateMap';
	args: unknown[];
	expected: Record<string, unknown> | unknown[];
}

function planView(p: FilePlan, want: Record<string, unknown>): Record<string, unknown> {
	const got: Record<string, unknown> = {
		status: p.status,
		reason: p.reason,
		reasonStartsWith: typeof want.reasonStartsWith === 'string' && p.reason?.startsWith(want.reasonStartsWith) ? want.reasonStartsWith : p.reason,
		result: p.output === undefined ? undefined : parseYaml(p.output),
		changes: p.changes.map((c) => [c.where, c.before, c.after]),
		notes: p.notes.map((n) => n.kind),
	};
	return Object.fromEntries(Object.keys(want).map((k) => [k, got[k]]));
}

describe('golden vectors (packages/spec/vectors/bases-property-repair.json)', () => {
	const cases = vectors.cases as Case[];
	it('has one vector or more for each of the 10 acceptance cases, and 20 or more in all', () => {
		for (let n = 1; n <= 10; n++) expect(cases.some((c) => c.name.startsWith(`AC${n} `))).toBe(true);
		expect(cases.length).toBeGreaterThanOrEqual(20);
	});
	for (const c of cases) {
		it(c.name, async () => {
			if (c.function === 'validateMap') {
				expect(validateMap(c.args[0] as { from: string; to: string }[])).toEqual(c.expected);
			} else if (c.function === 'rewriteExpression') {
				const r = rewriteExpression(c.args[0] as string, c.args[1] as KeyMap);
				expect({ text: r.text, changed: r.changed, skipped: r.skipped, notes: r.notes.map((n) => n.kind) }).toEqual(c.expected);
			} else if (c.function === 'planBase') {
				const want = c.expected as Record<string, unknown>;
				expect(planView(planBase(c.args[0] as string, c.args[1] as string, c.args[2] as KeyMap), want)).toEqual(want);
			} else {
				const [files, map, edits] = c.args as [Record<string, string>, KeyMap, Record<string, string>];
				const store = memoryStore(files);
				const plans = Object.keys(files)
					.filter((p) => p.endsWith('.base') && !p.startsWith('Restore/'))
					.map((p) => planBase(p, files[p]!, map));
				Object.assign(store.files, edits);
				const results = await applyPlans(store, plans, new Set(plans.map((p) => p.path)), 'Restore', '2026-10-13 101500');
				const want = c.expected as { files: Record<string, string> };
				// The restore copy must exist before the write: the store records the sequence of operations.
				for (const r of results.filter((x) => x.status === 'written')) expect(store.log.indexOf(`create ${r.copy}`)).toBeLessThan(store.log.indexOf(`write ${r.path}`));
				expect({ results: results.map((r) => (r.copy && r.status === 'written' ? [r.path, r.status, r.copy] : [r.path, r.status])), files: store.files }).toEqual(want);
			}
		});
	}
});
