import { afterEach, describe, expect, it } from 'vitest';
import { App } from 'obsidian-test-mocks/obsidian';
import BasesPropertyRepairPlugin, { fileStamp, toMap } from '../src/main';
import { PRO_UI, SPONSORS, bindPro, isPro, resetPro } from '../src/pro';
import { DEFAULT_FOLDER, DEFAULT_SETTINGS, normalizeSettings } from '../src/settings';
import manifest from '../manifest.json';

afterEach(() => resetPro());

function fakePro(on: boolean): void {
	bindPro({ isPro: () => on, onChange: () => () => undefined } as never);
}

const TASKS = 'filters:\n  and:\n    - note.status == "done"\nviews:\n  - type: table\n    name: All\n    order:\n      - file.name\n      - status\n';

async function setup(files: Record<string, string> = { 'Projects/Tasks.base': TASKS, 'notes/a.md': '# A' }) {
	const app = App.createConfigured__({ files });
	const plugin = new BasesPropertyRepairPlugin(app as never, manifest as never);
	await plugin.loadSettings();
	plugin.saveData = async () => undefined;
	return { app, plugin, vault: app.vault as unknown as { getFileByPath(p: string): unknown; read(f: unknown): Promise<string>; modify(f: unknown, t: string): Promise<void> } };
}

async function text(vault: Awaited<ReturnType<typeof setup>>['vault'], path: string): Promise<string | null> {
	const f = vault.getFileByPath(path);
	return f ? vault.read(f) : null;
}

describe('settings', () => {
	it('loads with default settings against an in-memory vault', async () => {
		const { plugin } = await setup();
		expect(plugin.settings).toEqual(DEFAULT_SETTINGS);
		expect(isPro()).toBe(false);
	});

	it('repairs bad saved settings', () => {
		expect(normalizeSettings({ restoreFolder: 5 as never, maps: 'x' as never, journal: [{ path: 1 }] as never })).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings({ restoreFolder: '/' }).restoreFolder).toBe(DEFAULT_FOLDER);
		expect(normalizeSettings({ restoreFolder: ' Backups/Bases/ ' }).restoreFolder).toBe('Backups/Bases');
	});

	it('stamps local time for restore copy names', () => {
		expect(fileStamp(new Date(2026, 9, 5, 7, 3, 9))).toBe('2026-10-05 070309');
		expect(toMap([{ from: 'a', to: 'b' }])).toEqual({ a: 'b' });
	});
});

describe('scan and apply in a vault', () => {
	it('scans .base files only and skips the restore copy folder', async () => {
		const { plugin } = await setup({ 'Projects/Tasks.base': TASKS, [`${DEFAULT_FOLDER}/Tasks old.base`]: TASKS, 'notes/a.md': 'status: x' });
		const plans = await plugin.scan([{ from: 'status', to: 'state' }]);
		expect(plans.map((p) => [p.path, p.status])).toEqual([['Projects/Tasks.base', 'change']]);
	});

	it('refuses a bad map and a map with two pairs in the free version', async () => {
		const { plugin } = await setup();
		await expect(plugin.scan([{ from: 'status', to: 'status' }])).rejects.toThrow('same as the old key');
		await expect(
			plugin.scan([
				{ from: 'a', to: 'b' },
				{ from: 'c', to: 'd' },
			]),
		).rejects.toThrow('pro feature');
	});

	it('writes a restore copy, then the new text, and adds a journal entry', async () => {
		const { plugin, vault } = await setup();
		const pairs = [{ from: 'status', to: 'state' }];
		const plans = await plugin.scan(pairs);
		const results = await plugin.apply(plans, new Set(['Projects/Tasks.base']), pairs, new Date(2026, 9, 13, 10, 15, 0));
		const copy = `${DEFAULT_FOLDER}/Tasks 2026-10-13 101500.base`;
		expect(results).toEqual([{ path: 'Projects/Tasks.base', status: 'written', copy, message: `Written. Restore copy ${copy}.` }]);
		expect(await text(vault, copy)).toBe(TASKS);
		const now = await text(vault, 'Projects/Tasks.base');
		expect(now).toContain('note.state == "done"');
		expect(now).toContain('- state');
		expect(plugin.settings.journal).toHaveLength(1);
		expect(plugin.settings.journal[0]).toMatchObject({ path: 'Projects/Tasks.base', copy, restored: false });
	});

	it('does not write an unchecked file', async () => {
		const { plugin, vault } = await setup();
		const pairs = [{ from: 'status', to: 'state' }];
		const results = await plugin.apply(await plugin.scan(pairs), new Set(), pairs);
		expect(results).toEqual([]);
		expect(await text(vault, 'Projects/Tasks.base')).toBe(TASKS);
	});

	it('reports a stale preview and does not write when the file changed after the scan', async () => {
		const { plugin, vault } = await setup();
		const pairs = [{ from: 'status', to: 'state' }];
		const plans = await plugin.scan(pairs);
		await vault.modify(vault.getFileByPath('Projects/Tasks.base'), TASKS + '# edited\n');
		const results = await plugin.apply(plans, new Set(['Projects/Tasks.base']), pairs);
		expect(results.map((r) => r.status)).toEqual(['stale']);
		expect(await text(vault, 'Projects/Tasks.base')).toBe(TASKS + '# edited\n');
		expect(plugin.settings.journal).toHaveLength(0);
	});
});

describe('pro features', () => {
	it('free version: journal restore and saved maps say pro', async () => {
		const { plugin } = await setup();
		expect(await plugin.saveMap('m', [{ from: 'a', to: 'b' }])).toContain('pro feature');
		expect(await plugin.restoreLast()).toContain('pro feature');
		expect(plugin.settings.maps).toEqual([]);
	});

	it('pro: saves a named map with two pairs and scans with it', async () => {
		const { plugin } = await setup();
		fakePro(true);
		const pairs = [
			{ from: 'status', to: 'state' },
			{ from: 'due', to: 'deadline' },
		];
		expect(await plugin.saveMap(' Q4 cleanup ', pairs)).toBeNull();
		expect(plugin.settings.maps).toEqual([{ name: 'Q4 cleanup', pairs }]);
		expect(await plugin.saveMap('', pairs)).toBe('Enter a name for the map.');
		const plans = await plugin.scan(pairs);
		expect(plans[0]?.status).toBe('change');
		await plugin.deleteMap('Q4 cleanup');
		expect(plugin.settings.maps).toEqual([]);
	});

	it('pro: restore writes the copy back, and refuses when the file changed after the repair', async () => {
		const { plugin, vault } = await setup();
		fakePro(true);
		const pairs = [{ from: 'status', to: 'state' }];
		await plugin.apply(await plugin.scan(pairs), new Set(['Projects/Tasks.base']), pairs, new Date(2026, 9, 13, 10, 15, 0));
		const entry = plugin.settings.journal[0]!;
		const repaired = (await text(vault, 'Projects/Tasks.base'))!;
		await vault.modify(vault.getFileByPath('Projects/Tasks.base'), repaired + '# later edit\n');
		expect(await plugin.restore(entry)).toContain('changed after the repair. Not restored.');
		expect(await text(vault, 'Projects/Tasks.base')).toBe(repaired + '# later edit\n');
		await vault.modify(vault.getFileByPath('Projects/Tasks.base'), repaired);
		expect(await plugin.restoreLast()).toContain('Restored Projects/Tasks.base');
		expect(await text(vault, 'Projects/Tasks.base')).toBe(TASKS);
		expect(entry.restored).toBe(true);
		expect(await plugin.restoreLast()).toBe('The journal has no change to restore.');
	});

	it('pro values match the reference', () => {
		expect(SPONSORS).toMatchObject({ clientId: 'Ov23lic5UPGPZqhBlBGg', sponsorLogin: 'theluckystrike', minMonthlyUsd: 5, oneTimeUsd: 15, scope: 'read:user' });
		expect(PRO_UI.priceText).toContain('$5 a month, or $15 once');
	});
});
