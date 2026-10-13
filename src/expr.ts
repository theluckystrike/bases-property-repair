// Scanner for Bases expressions (filters and formulas). It finds note property tokens and changes only the keys in
// the rename map. Text in strings, regular expressions, methods and the file, formula and this namespaces stays.
// Unknown syntax or a computed note[...] access stops all changes in that expression.

export type KeyMap = Readonly<Record<string, string>>;

export type NoteKind = 'unknown' | 'computed' | 'this' | 'ambiguous';

export interface ExprNote {
	kind: NoteKind;
	text: string;
}

export interface ExprResult {
	/** The new expression text. It is the source text when nothing changed or when the expression was skipped. */
	text: string;
	/** Number of property tokens that changed. */
	changed: number;
	/** True when a note stopped all changes in this expression. */
	skipped: boolean;
	notes: ExprNote[];
}

type TokType = 'ident' | 'number' | 'string' | 'regex' | 'punct';

interface Token {
	type: TokType;
	start: number;
	end: number;
	/** Identifier name, punctuation text, or the decoded value of a string. */
	value: string;
	/** Quote character of a string token. */
	quote?: string;
}

/** Words that are not note properties when they stand alone in an expression. */
export const RESERVED = new Set(['note', 'file', 'formula', 'this', 'true', 'false', 'null', 'value', 'index', 'acc', 'values']);

const IDENT = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;
const IDENT_START = /[\p{L}_$]/u;
const IDENT_PART = /[\p{L}\p{N}_$]/u;
const PUNCT2 = ['==', '!=', '>=', '<=', '&&', '||', '=>'];
const PUNCT1 = '()[],.?:!+-*/%><';

/** True when the key can stand as a bare identifier in an expression. */
export function isIdentifier(key: string): boolean {
	return IDENT.test(key);
}

class SyntaxProblem extends Error {}

function decodeString(body: string): string {
	return body.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_m, c: string) => {
		if (c.length === 5) return String.fromCharCode(parseInt(c.slice(1), 16));
		return c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c;
	});
}

function isOperand(t: Token | undefined): boolean {
	if (!t) return false;
	return t.type !== 'punct' || t.value === ')' || t.value === ']';
}

function tokenize(src: string): Token[] {
	const out: Token[] = [];
	let i = 0;
	while (i < src.length) {
		const c = src[i]!;
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		const start = i;
		if (c === '"' || c === "'") {
			i++;
			while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
			if (i >= src.length) throw new SyntaxProblem(`string without an end quote at position ${start + 1}`);
			i++;
			out.push({ type: 'string', start, end: i, value: decodeString(src.slice(start + 1, i - 1)), quote: c });
			continue;
		}
		if (/[0-9]/.test(c)) {
			const m = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(i))!;
			i += m[0].length;
			if (i < src.length && IDENT_PART.test(src[i]!)) throw new SyntaxProblem(`unknown token at position ${start + 1}`);
			out.push({ type: 'number', start, end: i, value: m[0] });
			continue;
		}
		if (IDENT_START.test(c)) {
			while (i < src.length && IDENT_PART.test(src[i]!)) i++;
			out.push({ type: 'ident', start, end: i, value: src.slice(start, i) });
			continue;
		}
		if (c === '/' && !isOperand(out[out.length - 1])) {
			i++;
			let inClass = false;
			while (i < src.length && (src[i] !== '/' || inClass)) {
				if (src[i] === '\\') i++;
				else if (src[i] === '[') inClass = true;
				else if (src[i] === ']') inClass = false;
				i++;
			}
			if (i >= src.length) throw new SyntaxProblem(`regular expression without an end at position ${start + 1}`);
			i++;
			while (i < src.length && /[a-z]/.test(src[i]!)) i++;
			out.push({ type: 'regex', start, end: i, value: src.slice(start, i) });
			continue;
		}
		const two = src.slice(i, i + 2);
		if (PUNCT2.includes(two)) {
			i += 2;
			out.push({ type: 'punct', start, end: i, value: two });
			continue;
		}
		if (PUNCT1.includes(c)) {
			i++;
			out.push({ type: 'punct', start, end: i, value: c });
			continue;
		}
		throw new SyntaxProblem(`unknown character "${c}" at position ${start + 1}`);
	}
	return out;
}

function quoteKey(key: string, quote: string): string {
	const body = key.replace(/\\/g, '\\\\').replace(new RegExp(quote, 'g'), `\\${quote}`);
	return `${quote}${body}${quote}`;
}

/** Text for a reference to the key: bare, note.key, or note["key"] (kept for bracket input and needed for a key that is not an identifier). */
export function formatRef(key: string, bare: boolean, quote?: string): string {
	if (quote !== undefined || !isIdentifier(key)) return `note[${quoteKey(key, quote ?? '"')}]`;
	if (bare && !RESERVED.has(key)) return key;
	return `note.${key}`;
}

function has(map: KeyMap, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(map, key);
}

function mentions(src: string, map: KeyMap): boolean {
	return Object.keys(map).some((k) => src.includes(k));
}

/** Changes the note property references of an expression for each key in the map. */
export function rewriteExpression(src: string, map: KeyMap): ExprResult {
	const unchanged = (notes: ExprNote[]): ExprResult => ({ text: src, changed: 0, skipped: notes.length > 0, notes });
	let toks: Token[];
	try {
		toks = tokenize(src);
	} catch (e) {
		if (!(e instanceof SyntaxProblem)) throw e;
		return unchanged(mentions(src, map) ? [{ kind: 'unknown', text: `Unknown syntax, ${e.message}` }] : []);
	}
	const edits: { start: number; end: number; text: string }[] = [];
	const notes: ExprNote[] = [];
	for (let i = 0; i < toks.length; i++) {
		const t = toks[i]!;
		const prev = toks[i - 1];
		const next = toks[i + 1];
		if (t.type !== 'ident' || (prev?.type === 'punct' && prev.value === '.')) continue;
		const memberAccess = next?.type === 'punct' && next.value === '.' && toks[i + 2]?.type === 'ident';
		const member = memberAccess ? toks[i + 2]! : null;
		if (t.value === 'note') {
			if (member) {
				const called = toks[i + 3]?.type === 'punct' && toks[i + 3]!.value === '(';
				if (has(map, member.value) && !called) edits.push({ start: t.start, end: member.end, text: formatRef(map[member.value]!, false) });
				i += 2;
			} else if (next?.type === 'punct' && next.value === '[') {
				const key = toks[i + 2];
				const close = toks[i + 3];
				if (key?.type === 'string' && close?.type === 'punct' && close.value === ']') {
					if (has(map, key.value)) edits.push({ start: t.start, end: close.end, text: formatRef(map[key.value]!, false, key.quote) });
					i += 3;
				} else {
					return unchanged([{ kind: 'computed', text: 'Computed access note[...] can name a renamed key. No change in this expression.' }]);
				}
			}
			continue;
		}
		if (t.value === 'this' && member && has(map, member.value)) {
			notes.push({ kind: 'this', text: `this.${member.value} reads the note that embeds the base. Not changed.` });
			continue;
		}
		if (!has(map, t.value)) continue;
		if (next?.type === 'punct' && next.value === '(') continue;
		if (RESERVED.has(t.value)) {
			notes.push({ kind: 'ambiguous', text: `Bare ${t.value} is a reserved word, not a property. Not changed.` });
			continue;
		}
		edits.push({ start: t.start, end: t.end, text: formatRef(map[t.value]!, true) });
	}
	let text = src;
	for (const e of [...edits].reverse()) text = text.slice(0, e.start) + e.text + text.slice(e.end);
	return { text, changed: edits.length, skipped: false, notes };
}
