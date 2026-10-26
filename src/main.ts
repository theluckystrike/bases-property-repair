import { Notice, Plugin, TFile, normalizePath } from 'obsidian';
import type { SponsorsManager } from './license/index';
import { createGitHubSponsors } from './license/github-obsidian';
import { SPONSORS, bindPro, isPro, proNotice, proText, resetPro } from './pro';
import { applyPlans, planBase, textHash, validateMap, type ApplyResult, type FilePlan, type Store } from './repair';
import { DEFAULT_SETTINGS, JOURNAL_MAX, BasesPropertyRepairSettingTab, normalizeSettings, type BasesPropertyRepairSettings, type JournalEntry, type RenamePair } from './settings';
import { JournalModal, RepairModal } from './ui';
import { setupHello } from './hello/index';
import WHATS_NEW from './whats-new.json';

/** How often to ask the license state whether a check is due. It sends a request only when signed in and due (7 days). */
const PRO_TICK_MS = 6 * 60 * 60 * 1000;

export const PRO_LEAD = 'This is a pro feature.';

/** "2026-10-13 101500" in local time, for restore copy names. */
export function fileStamp(d: Date): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** The rename map object of a list of pairs. */
export function toMap(pairs: readonly RenamePair[]): Record<string, string> {
	const map: Record<string, string> = {};
	for (const p of pairs) map[p.from] = p.to;
	return map;
}

export default class BasesPropertyRepairPlugin extends Plugin {
	settings: BasesPropertyRepairSettings = { ...DEFAULT_SETTINGS };
	/** GitHub Sponsors Pro state. Created in onload; null before that. */
	pro: SponsorsManager | null = null;
	private settingTab: BasesPropertyRepairSettingTab | null = null;
	/** The repair modal and the journal modal opened last. onunload closes them. */
	modal: RepairModal | null = null;
	journalModal: JournalModal | null = null;

	async onload(): Promise<void> {
		// First: "What's new" reads its state before the settings load (packages/hello). It does not wait.
		setupHello(this, WHATS_NEW);
		await this.loadSettings();
		// No request here: a request needs a GitHub sign in first (Settings, Pro, Sign in with GitHub).
		const pro = createGitHubSponsors(this.app, this.manifest.id, SPONSORS, this);
		pro.init();
		this.pro = pro;
		bindPro(pro);
		this.register(pro.onChange(() => this.settingTab?.update()));
		this.settingTab = new BasesPropertyRepairSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		this.addCommand({
			id: 'repair',
			name: 'Repair property references in base files',
			callback: () => void this.openRepair(),
		});
		this.addCommand({
			id: 'show-journal',
			name: 'Show the change journal',
			callback: () => {
				if (!isPro()) proNotice(PRO_LEAD);
				else {
					this.journalModal = new JournalModal(this.app, this);
					this.journalModal.open();
				}
			},
		});
		this.addCommand({
			id: 'restore-last',
			name: 'Restore the last change from the journal',
			callback: () => void this.restoreLast(),
		});
		this.app.workspace.onLayoutReady(() => {
			void pro.refresh();
			this.registerInterval(window.setInterval(() => void pro.refresh(), PRO_TICK_MS));
		});
	}

	onunload(): void {
		this.closeModals();
		resetPro();
	}

	async loadSettings(): Promise<void> {
		this.settings = normalizeSettings((await this.loadData()) as Partial<BasesPropertyRepairSettings> | null);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Opens the repair modal, with the pairs filled in when given. */
	openRepair(pairs?: RenamePair[]): RepairModal {
		const modal = new RepairModal(this.app, this);
		modal.open();
		this.modal = modal;
		if (pairs) modal.setPairs(pairs);
		return modal;
	}

	/** Closes the repair modal and the journal modal of this plugin. */
	closeModals(): void {
		this.modal?.close();
		this.journalModal?.close();
		this.modal = null;
		this.journalModal = null;
	}

	/** True when the path is inside the restore copy folder. */
	inRestoreFolder(path: string): boolean {
		return path.startsWith(this.settings.restoreFolder + '/');
	}

	/** The .base files of the vault outside the restore copy folder, sorted by path. Restore copies in the journal stay out too, also after a folder change. */
	baseFiles(): TFile[] {
		const copies = new Set(this.settings.journal.map((e) => e.copy));
		return this.app.vault
			.getFiles()
			.filter((f) => f.extension === 'base' && !this.inRestoreFolder(f.path) && !copies.has(f.path))
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	/** Reads each .base file and plans the rename. Throws on a bad map. */
	async scan(pairs: readonly RenamePair[]): Promise<FilePlan[]> {
		const problems = validateMap(pairs);
		if (problems.length > 0) throw new Error(problems.join(' '));
		if (pairs.length > 1 && !isPro()) throw new Error('A map with more than one pair is a pro feature.');
		const map = toMap(pairs);
		const plans: FilePlan[] = [];
		for (const file of this.baseFiles()) plans.push(planBase(file.path, await this.app.vault.read(file), map));
		return plans;
	}

	/** The vault as a Store for applyPlans. */
	store(): Store {
		const vault = this.app.vault;
		const fileAt = (path: string): TFile => {
			const f = vault.getFileByPath(path);
			if (!f) throw new Error(`${path} is gone`);
			return f;
		};
		return {
			read: async (path) => {
				const f = vault.getFileByPath(path);
				return f ? vault.read(f) : null;
			},
			exists: (path) => vault.getAbstractFileByPath(path) !== null,
			ensureFolder: async (path) => {
				let cur = '';
				for (const part of normalizePath(path).split('/')) {
					cur = cur ? `${cur}/${part}` : part;
					if (!vault.getAbstractFileByPath(cur)) await vault.createFolder(cur);
				}
			},
			create: async (path, text) => {
				await vault.create(path, text);
			},
			process: async (path, fn) => {
				await vault.process(fileAt(path), fn);
			},
		};
	}

	/** Writes the checked plans that still match, with a restore copy first, and adds journal entries. */
	async apply(plans: readonly FilePlan[], checked: ReadonlySet<string>, pairs: readonly RenamePair[], now = new Date()): Promise<ApplyResult[]> {
		const results = await applyPlans(this.store(), plans, checked, this.settings.restoreFolder, fileStamp(now));
		const byPath = new Map(plans.map((p) => [p.path, p]));
		for (const r of results) {
			const plan = byPath.get(r.path);
			if (r.status !== 'written' || !r.copy || plan?.output === undefined) continue;
			this.settings.journal.push({ time: now.toISOString(), path: r.path, copy: r.copy, pairs: pairs.map((p) => ({ ...p })), hash: textHash(plan.output), restored: false });
		}
		this.settings.journal = this.settings.journal.slice(-JOURNAL_MAX);
		if (results.some((r) => r.status === 'written')) await this.saveSettings();
		return results;
	}

	/** Pro: writes the restore copy back, but only while the file still has the text that the plugin wrote. */
	async restore(entry: JournalEntry): Promise<string> {
		if (!isPro()) return proText(PRO_LEAD);
		if (entry.restored) return `${entry.path} is already restored.`;
		const vault = this.app.vault;
		const file = vault.getFileByPath(entry.path);
		if (!file) return `${entry.path} is gone. Not restored.`;
		const copy = vault.getFileByPath(entry.copy);
		if (!copy) return `The restore copy ${entry.copy} is gone. Not restored.`;
		const old = await vault.read(copy);
		let changed = false;
		await vault.process(file, (data) => {
			if (textHash(data) !== entry.hash) {
				changed = true;
				return data;
			}
			return old;
		});
		if (changed) return `${entry.path} changed after the repair. Not restored. Open the restore copy ${entry.copy} to compare.`;
		entry.restored = true;
		await this.saveSettings();
		return `Restored ${entry.path} from ${entry.copy}.`;
	}

	/** Pro: restores the newest journal entry that is not restored. */
	async restoreLast(): Promise<string> {
		if (!isPro()) {
			proNotice(PRO_LEAD);
			return proText(PRO_LEAD);
		}
		const entry = [...this.settings.journal].reverse().find((e) => !e.restored);
		const msg = entry ? await this.restore(entry) : 'The journal has no change to restore.';
		new Notice(msg);
		return msg;
	}

	/** Pro: saves or replaces a named map. Returns a problem sentence or null. */
	async saveMap(name: string, pairs: readonly RenamePair[]): Promise<string | null> {
		if (!isPro()) return proText(PRO_LEAD);
		const n = name.trim();
		if (!n) return 'Enter a name for the map.';
		const problems = validateMap(pairs);
		if (problems.length > 0) return problems.join(' ');
		const maps = this.settings.maps.filter((m) => m.name !== n);
		maps.push({ name: n, pairs: pairs.map((p) => ({ ...p })) });
		this.settings.maps = maps.sort((a, b) => a.name.localeCompare(b.name));
		await this.saveSettings();
		return null;
	}

	/** Pro: deletes a named map. */
	async deleteMap(name: string): Promise<void> {
		this.settings.maps = this.settings.maps.filter((m) => m.name !== name);
		await this.saveSettings();
	}
}
