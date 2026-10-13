// Plans and applies property renames in the YAML of one .base file. The plan is pure: text in, plan out.
// applyPlans writes through a small Store, so the same code runs on the Obsidian vault and on tests.
import { parseYaml, stringifyYaml } from 'obsidian';
import { rewriteExpression, type KeyMap, type NoteKind } from './expr';

export interface Change {
	where: string;
	before: string;
	after: string;
}

export interface PlanNote {
	where: string;
	kind: NoteKind | 'comments' | 'option';
	text: string;
}

export interface FilePlan {
	path: string;
	/** change = there is new text to write, none = no reference found, skip = the file is not changed (see reason). */
	status: 'change' | 'none' | 'skip';
	reason?: string;
	changes: Change[];
	notes: PlanNote[];
	/** The file text at scan time. Apply writes only if the file still has this text. */
	source: string;
	/** The new file text when status is change. */
	output?: string;
}

type Obj = Record<string, unknown>;

const NAMESPACES = ['file.', 'formula.', 'this.'];
/** View keys that need no change. Other view keys are custom options: listed when they mention a key, never changed. */
const SAFE_VIEW_KEYS = new Set(['type', 'name', 'limit']);
const FILTER_KEYS = new Set(['and', 'or', 'not']);

function isObj(v: unknown): v is Obj {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function has(map: KeyMap, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(map, key);
}

/** Checks a rename map. Returns the problems as sentences; an empty list means the map is good. */
export function validateMap(pairs: readonly { from: string; to: string }[]): string[] {
	const problems: string[] = [];
	const seenFrom = new Set<string>();
	const seenTo = new Set<string>();
	if (pairs.length === 0) problems.push('Enter an old key and a new key.');
	for (const { from, to } of pairs) {
		if (!from.trim() || !to.trim()) problems.push('Enter an old key and a new key.');
		else if (from !== from.trim() || to !== to.trim()) problems.push(`Remove the spaces at the start or end of "${from.trim()}" or "${to.trim()}".`);
		else if (/[\n\r]/.test(from + to)) problems.push('A key cannot contain a line break.');
		else if (from === to) problems.push(`The new key for "${from}" is the same as the old key.`);
		else if ([...NAMESPACES, 'note.'].some((p) => from.startsWith(p) || to.startsWith(p))) problems.push(`Enter "${from}" and "${to}" without a note., file., formula. or this. prefix.`);
		if (seenFrom.has(from)) problems.push(`The old key "${from}" is in the map two times.`);
		if (seenTo.has(to)) problems.push(`Two old keys have the same new key "${to}".`);
		seenFrom.add(from);
		seenTo.add(to);
	}
	return [...new Set(problems)];
}

/** The key that a property ID names, or null for file., formula. and this. IDs. "status" and "note.status" both give "status". */
export function idKey(id: string): string | null {
	if (id.startsWith('note.')) return id.slice(5);
	if (NAMESPACES.some((p) => id.startsWith(p))) return null;
	return id;
}

/** The property ID with its key renamed, in the same form (bare or note.), or null when the map does not name it. */
export function renameId(id: string, map: KeyMap): string | null {
	const key = idKey(id);
	if (key === null || !has(map, key)) return null;
	return id.startsWith('note.') ? `note.${map[key]!}` : map[key]!;
}

function mentions(value: unknown, map: KeyMap): boolean {
	const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
	return Object.keys(map).some((k) => text.includes(k));
}

class Skip extends Error {}

class Planner {
	readonly changes: Change[] = [];
	readonly notes: PlanNote[] = [];

	constructor(private readonly map: KeyMap) {}

	expr(src: string, where: string): string {
		const r = rewriteExpression(src, this.map);
		for (const n of r.notes) this.notes.push({ where, kind: n.kind, text: n.text });
		if (r.changed > 0) this.changes.push({ where, before: src, after: r.text });
		return r.text;
	}

	other(value: unknown, where: string, text: string, kind: PlanNote['kind'] = 'unknown'): unknown {
		if (mentions(value, this.map)) this.notes.push({ where, kind, text });
		return value;
	}

	filter(node: unknown, where: string): unknown {
		if (typeof node === 'string') return this.expr(node, where);
		if (isObj(node)) {
			const out: Obj = {};
			for (const [k, v] of Object.entries(node)) {
				if (FILTER_KEYS.has(k) && Array.isArray(v)) out[k] = v.map((item, i) => this.filter(item, `${where}.${k}[${i}]`));
				else out[k] = this.other(v, `${where}.${k}`, `Unknown filter key "${k}". Not changed.`);
			}
			return out;
		}
		return this.other(node, where, 'Unknown filter value. Not changed.');
	}

	id(value: unknown, where: string): unknown {
		if (typeof value !== 'string') return this.other(value, where, 'A property ID that is not text. Not changed.');
		const next = renameId(value, this.map);
		if (next === null) return value;
		this.changes.push({ where, before: value, after: next });
		return next;
	}

	/** Renames the property ID keys of an object such as properties or summaries. Skips the file on a clash. */
	idKeys(obj: unknown, where: string): unknown {
		if (!isObj(obj)) return this.other(obj, where, `${where} is not a map. Not changed.`);
		const out: Obj = {};
		const renamed = new Set<string>();
		for (const k of Object.keys(obj)) if (renameId(k, this.map) !== null) renamed.add(k);
		const staying = new Set(Object.keys(obj).filter((k) => !renamed.has(k)).map((k) => idKey(k)));
		for (const [k, v] of Object.entries(obj)) {
			const next = renameId(k, this.map);
			if (next === null) {
				out[k] = v;
				continue;
			}
			const target = idKey(next);
			if (staying.has(target) || Object.prototype.hasOwnProperty.call(out, next)) throw new Skip(`${where} already has a setting for "${target ?? next}". Merge or remove it first.`);
			this.changes.push({ where: `${where} key`, before: k, after: next });
			out[next] = v;
		}
		return out;
	}

	view(view: unknown, where: string): unknown {
		if (!isObj(view)) return this.other(view, where, 'A view that is not a map. Not changed.');
		const out: Obj = {};
		for (const [k, v] of Object.entries(view)) {
			const at = `${where}.${k}`;
			if (k === 'filters') out[k] = this.filter(v, at);
			else if (k === 'order' && Array.isArray(v)) out[k] = v.map((id, i) => this.id(id, `${at}[${i}]`));
			else if (k === 'sort' && Array.isArray(v)) out[k] = v.map((s, i) => (isObj(s) && 'property' in s ? { ...s, property: this.id(s.property, `${at}[${i}].property`) } : this.other(s, `${at}[${i}]`, 'Unknown sort entry. Not changed.')));
			else if (k === 'groupBy' && isObj(v) && 'property' in v) out[k] = { ...v, property: this.id(v.property, `${at}.property`) };
			else if (k === 'summaries') out[k] = this.idKeys(v, at);
			else if (SAFE_VIEW_KEYS.has(k)) out[k] = v;
			else out[k] = this.other(v, at, `Custom view option "${k}". Not changed.`, 'option');
		}
		return out;
	}

	base(root: Obj): Obj {
		const out: Obj = {};
		for (const [k, v] of Object.entries(root)) {
			if (k === 'filters') out[k] = this.filter(v, k);
			else if (k === 'formulas' && isObj(v)) out[k] = Object.fromEntries(Object.entries(v).map(([name, f]) => [name, typeof f === 'string' ? this.expr(f, `formulas.${name}`) : this.other(f, `formulas.${name}`, 'A formula that is not text. Not changed.')]));
			else if (k === 'properties') out[k] = this.idKeys(v, k);
			else if (k === 'views' && Array.isArray(v)) out[k] = v.map((view, i) => this.view(view, `views[${i}]`));
			else out[k] = this.other(v, k, `Unknown section "${k}". Not changed.`);
		}
		return out;
	}
}

/** YAML comment lines or trailing comments. stringifyYaml does not keep them. */
export function hasComments(text: string): boolean {
	return /(^|\s)#/m.test(text.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\n]|'')*'/g, '""'));
}

/** Plans the rename for the text of one .base file. */
export function planBase(path: string, text: string, map: KeyMap): FilePlan {
	const plan: FilePlan = { path, status: 'none', changes: [], notes: [], source: text };
	let root: unknown;
	try {
		root = parseYaml(text);
	} catch (e) {
		return { ...plan, status: 'skip', reason: `Invalid YAML: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}` };
	}
	if (root === null || root === undefined) return plan;
	if (!isObj(root)) return { ...plan, status: 'skip', reason: 'The file is not a YAML map.' };
	const p = new Planner(map);
	let next: Obj;
	try {
		next = p.base(root);
	} catch (e) {
		if (e instanceof Skip) return { ...plan, status: 'skip', reason: e.message, notes: p.notes };
		throw e;
	}
	if (p.changes.length === 0) return { ...plan, notes: p.notes };
	const notes = [...p.notes];
	if (hasComments(text)) notes.push({ where: 'file', kind: 'comments', text: 'This file has YAML comments. Apply writes the file again without them.' });
	return { ...plan, status: 'change', changes: p.changes, notes, output: stringifyYaml(next) };
}

export interface Store {
	read(path: string): Promise<string | null>;
	exists(path: string): boolean;
	ensureFolder(path: string): Promise<void>;
	create(path: string, text: string): Promise<void>;
	/** Replaces the text atomically. fn gets the current text and returns the new text. */
	process(path: string, fn: (data: string) => string): Promise<void>;
}

export interface ApplyResult {
	path: string;
	status: 'written' | 'stale' | 'error';
	message: string;
	copy?: string;
}

function baseName(path: string): string {
	const name = path.split('/').pop() ?? path;
	return name.replace(/\.base$/i, '');
}

/** A free path for a restore copy: "<folder>/<name> <stamp>.base", then " 2", " 3" and on. */
export function restorePath(store: Pick<Store, 'exists'>, folder: string, source: string, stamp: string): string {
	const stem = `${folder ? folder + '/' : ''}${baseName(source)} ${stamp}`;
	let path = `${stem}.base`;
	for (let n = 2; store.exists(path); n++) path = `${stem} ${n}.base`;
	return path;
}

/** Writes each plan in "checked" that still matches its source text. A restore copy is made before each write. */
export async function applyPlans(store: Store, plans: readonly FilePlan[], checked: ReadonlySet<string>, folder: string, stamp: string): Promise<ApplyResult[]> {
	const results: ApplyResult[] = [];
	for (const plan of plans) {
		if (plan.status !== 'change' || plan.output === undefined || !checked.has(plan.path)) continue;
		const output = plan.output;
		try {
			const current = await store.read(plan.path);
			if (current !== plan.source) {
				results.push({ path: plan.path, status: 'stale', message: current === null ? 'The file is gone. Not written.' : 'The file changed after the preview. Not written. Scan again.' });
				continue;
			}
			const copy = restorePath(store, folder, plan.path, stamp);
			if (folder) await store.ensureFolder(folder);
			await store.create(copy, plan.source);
			let stale = false;
			await store.process(plan.path, (data) => {
				if (data !== plan.source) {
					stale = true;
					return data;
				}
				return output;
			});
			results.push(
				stale
					? { path: plan.path, status: 'stale', copy, message: 'The file changed after the preview. Not written. Scan again.' }
					: { path: plan.path, status: 'written', copy, message: `Written. Restore copy ${copy}.` },
			);
		} catch (e) {
			results.push({ path: plan.path, status: 'error', message: `Not written: ${e instanceof Error ? e.message : String(e)}` });
		}
	}
	return results;
}

/** A short hash of a text (FNV-1a, 32 bit), for the journal's restore guard. */
export function textHash(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
}
