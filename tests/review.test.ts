import { afterEach, describe, expect, it } from 'vitest';
import { App } from 'obsidian-test-mocks/obsidian';
import BasesPropertyRepairPlugin from '../src/main';
import { resetPro } from '../src/pro';
import { DEFAULT_FOLDER } from '../src/settings';
import { RepairModal } from '../src/ui';
import manifest from '../manifest.json';

afterEach(() => resetPro());

const TASKS = 'filters:\n  and:\n    - note.status == "done"\nviews:\n  - type: table\n    name: All\n    order:\n      - file.name\n      - status\n';

async function setup(files: Record<string, string>) {
	const app = App.createConfigured__({ files });
	const plugin = new BasesPropertyRepairPlugin(app as never, manifest as never);
	await plugin.loadSettings();
	plugin.saveData = async () => undefined;
	return { app, plugin };
}

describe('review defects', () => {
	it('does not scan or rewrite a restore copy after the restore folder setting changes', async () => {
		const { plugin } = await setup({ 'Projects/Tasks.base': TASKS });
		const pairs = [{ from: 'status', to: 'state' }];
		await plugin.apply(await plugin.scan(pairs), new Set(['Projects/Tasks.base']), pairs, new Date(2026, 9, 13, 10, 15, 0));
		const copy = `${DEFAULT_FOLDER}/Tasks 2026-10-13 101500.base`;
		expect(plugin.settings.journal[0]?.copy).toBe(copy);
		plugin.settings.restoreFolder = 'Backups';
		const plans = await plugin.scan([{ from: 'state', to: 'phase' }]);
		expect(plans.map((p) => p.path)).not.toContain(copy);
	});

	it('records the pairs of the scan in the journal, not pairs edited after the scan', async () => {
		const { app, plugin } = await setup({ 'Projects/Tasks.base': TASKS });
		const modal = new RepairModal(app as never, plugin);
		modal.open();
		modal.setPairs([{ from: 'status', to: 'state' }]);
		await modal.scan();
		modal.pairs[0]!.to = 'phase';
		await modal.apply();
		expect(plugin.settings.journal[0]?.pairs).toEqual([{ from: 'status', to: 'state' }]);
		modal.close();
	});
});
