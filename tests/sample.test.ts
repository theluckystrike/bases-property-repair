import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planBase } from '../src/repair';

// The sample Base files in docs/sample-notes, which the screenshots and the e2e vault use.
const DIR = join(__dirname, '..', 'docs', 'sample-notes');
const plans = readdirSync(DIR)
	.filter((f) => f.endsWith('.base'))
	.sort()
	.map((f) => planBase(f, readFileSync(join(DIR, f), 'utf8'), { status: 'state' }));
const byName = Object.fromEntries(plans.map((p) => [p.path, p]));

describe('sample Base files, status to state', () => {
	it('gives the planned status for each file', () => {
		expect(plans.map((p) => [p.path, p.status])).toEqual([
			['Board.base', 'change'],
			['Broken.base', 'skip'],
			['Clash.base', 'skip'],
			['Computed.base', 'change'],
			['Projects.base', 'change'],
			['Reading list.base', 'change'],
		]);
	});

	it('Projects.base: 7 changes and a comment note', () => {
		expect(byName['Projects.base']!.changes).toHaveLength(7);
		expect(byName['Projects.base']!.notes.map((n) => n.kind)).toEqual(['comments']);
	});

	it('Reading list.base: note["status"] and note.status change, formula.status, file.hasTag("status") and status_code stay', () => {
		const p = byName['Reading list.base']!;
		expect(p.changes.map((c) => c.after)).toEqual(['note["state"] == "reading"', 'note.state']);
		expect(p.output).toContain('formula.status');
		expect(p.output).toContain('file.hasTag("status")');
		expect(p.output).toContain('status_code');
	});

	it('Board.base: groupBy changes, the columnSize option is listed and stays', () => {
		const p = byName['Board.base']!;
		expect(p.changes.map((c) => c.where)).toEqual(['views[0].groupBy.property']);
		expect(p.notes.map((n) => n.kind)).toEqual(['option']);
		expect(p.output).toContain('note.status: 160');
	});

	it('Computed.base: note[field] stops changes in that formula only', () => {
		const p = byName['Computed.base']!;
		expect(p.notes.map((n) => [n.where, n.kind])).toEqual([['formulas.picked', 'computed']]);
		expect(p.changes.map((c) => c.after)).toEqual(['state == "status"']);
	});

	it('Broken.base and Clash.base give a reason', () => {
		expect(byName['Broken.base']!.reason).toMatch(/^Invalid YAML: /);
		expect(byName['Clash.base']!.reason).toBe('properties already has a setting for "state". Merge or remove it first.');
	});
});
