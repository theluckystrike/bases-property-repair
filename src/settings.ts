import { PluginSettingTab, normalizePath, type SettingDefinitionItem } from 'obsidian';
import { sponsorsSettingItems } from './license/github-obsidian';
import { PRO_UI, isPro } from './pro';
import type BasesPropertyRepairPlugin from './main';

export interface RenamePair {
	from: string;
	to: string;
}

export interface SavedMap {
	name: string;
	pairs: RenamePair[];
}

export interface JournalEntry {
	/** ISO time of the write. */
	time: string;
	path: string;
	/** Path of the restore copy with the text before the write. */
	copy: string;
	pairs: RenamePair[];
	/** textHash of the text that the plugin wrote. Restore writes only while the file still has this text. */
	hash: string;
	restored: boolean;
}

export interface BasesPropertyRepairSettings {
	/** Vault folder for restore copies. Scans skip this folder. */
	restoreFolder: string;
	/** Pro: named rename maps. */
	maps: SavedMap[];
	/** The newest writes, newest last. The list is kept for all users; Pro shows it and restores from it. */
	journal: JournalEntry[];
}

export const JOURNAL_MAX = 200;
export const DEFAULT_FOLDER = 'Bases Property Repair/Restore copies';

export const DEFAULT_SETTINGS: BasesPropertyRepairSettings = {
	restoreFolder: DEFAULT_FOLDER,
	maps: [],
	journal: [],
};

function isPair(p: unknown): p is RenamePair {
	return typeof p === 'object' && p !== null && typeof (p as RenamePair).from === 'string' && typeof (p as RenamePair).to === 'string';
}

/** Clean folder path: no slashes at the ends, "/" and "" give the default. */
export function cleanFolder(folder: unknown): string {
	if (typeof folder !== 'string') return DEFAULT_FOLDER;
	const p = normalizePath(folder.trim());
	return p === '/' || p === '' ? DEFAULT_FOLDER : p;
}

/** Fills gaps and drops bad values from saved data, so old or hand-edited data.json never breaks the plugin. */
export function normalizeSettings(saved: Partial<BasesPropertyRepairSettings> | null | undefined): BasesPropertyRepairSettings {
	const s = saved ?? {};
	const maps = Array.isArray(s.maps) ? s.maps.filter((m): m is SavedMap => typeof m?.name === 'string' && Array.isArray(m.pairs) && m.pairs.every(isPair)) : [];
	const journal = Array.isArray(s.journal)
		? s.journal.filter((j): j is JournalEntry => ['time', 'path', 'copy', 'hash'].every((k) => typeof (j as unknown as Record<string, unknown>)?.[k] === 'string') && Array.isArray(j.pairs)).map((j) => ({ ...j, restored: j.restored === true }))
		: [];
	return {
		restoreFolder: cleanFolder(s.restoreFolder),
		maps,
		journal: journal.slice(-JOURNAL_MAX),
	};
}

export class BasesPropertyRepairSettingTab extends PluginSettingTab {
	plugin: BasesPropertyRepairPlugin;

	constructor(app: ConstructorParameters<typeof PluginSettingTab>[0], plugin: BasesPropertyRepairPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			...(this.plugin.pro ? sponsorsSettingItems(this.plugin.pro, PRO_UI) : []),
			{
				name: 'Restore copy folder',
				desc: 'Vault folder for the restore copies. Apply puts a copy of each Base file here before it writes the file. Scans skip this folder.',
				control: { type: 'text', key: 'restoreFolder', defaultValue: DEFAULT_FOLDER, placeholder: DEFAULT_FOLDER },
			},
			{
				name: 'Pro features',
				desc: isPro()
					? `Pro is on: saved rename maps (${this.plugin.settings.maps.length} saved) and the change journal with restore.`
					: 'Free version: scan, preview, restore copies and apply. Pro adds named rename maps with one or more key pairs, and a change journal with a guarded restore command.',
			},
		];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		await super.setControlValue(key, value);
		this.plugin.settings = normalizeSettings(this.plugin.settings);
		await this.plugin.saveSettings();
	}
}
