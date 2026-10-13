import { browser, expect } from '@wdio/globals';
import { pluginId } from './load';

// Real-app checks with real typing and clicks in the repair modal. Each wait is on the data-state marker of the
// modal or on file text, never on a fixed delay, so the test does not depend on machine speed or the theme.
const DIR = 'Bases Property Repair';
const BASE = `${DIR}/Projects.base`;

async function readFile(path: string): Promise<string | null> {
	return browser.executeObsidian(async ({ app }, p) => {
		const f = app.vault.getFileByPath(p);
		return f ? app.vault.read(f) : null;
	}, path);
}

async function writeFile(path: string, text: string): Promise<void> {
	await browser.executeObsidian(
		async ({ app }, p, t) => {
			const f = app.vault.getFileByPath(p);
			if (f) await app.vault.modify(f, t);
		},
		path,
		text,
	);
}

async function waitState(state: string): Promise<void> {
	await browser.waitUntil(async () => (await browser.$('.bpr-modal').getAttribute('data-state')) === state, { timeout: 15000, timeoutMsg: `modal state is not ${state}` });
}

async function openAndScan(from: string, to: string): Promise<void> {
	await browser.executeObsidianCommand(`${pluginId}:repair`);
	await browser.$('.bpr-modal').waitForExist({ timeout: 10000 });
	await waitState('idle');
	const inputs = await browser.$$('.bpr-modal .bpr-pair input');
	await inputs[0]!.setValue(from);
	await inputs[1]!.setValue(to);
	await browser.$('.bpr-modal button.bpr-scan').click();
	await waitState('scanned');
}

async function closeModal(): Promise<void> {
	await browser.executeObsidian(({ app }, id) => {
		(app as unknown as { plugins: { plugins: Record<string, { modal: { close(): void } | null }> } }).plugins.plugins[id]?.modal?.close();
	}, pluginId);
	await browser.$('.bpr-modal').waitForExist({ reverse: true, timeout: 10000 });
}

describe('repair modal in a real vault', function () {
	let original = '';

	before(async function () {
		await browser.executeObsidian(async ({ app }) => {
			await new Promise<void>((resolve) => app.workspace.onLayoutReady(resolve));
		});
		await browser.waitUntil(async () => (await readFile(BASE)) !== null, { timeout: 15000 });
		original = (await readFile(BASE))!;
	});

	afterEach(async function () {
		if (await browser.$('.bpr-modal').isExisting()) await closeModal();
		await writeFile(BASE, original);
	});

	it('scans the sample files and lists changes, skips and notes', async function () {
		await openAndScan('status', 'state');
		const files = await browser.executeObsidian(() =>
			Array.from(document.querySelectorAll('.bpr-modal .bpr-file')).map((el) => [(el as HTMLElement).dataset.path, el.className.replace(/.*is-/, ''), el.querySelectorAll('.bpr-changes li').length]),
		);
		expect(files).toEqual([
			[`${DIR}/Board.base`, 'change', 1],
			[`${DIR}/Computed.base`, 'change', 1],
			[`${DIR}/Projects.base`, 'change', 7],
			[`${DIR}/Reading list.base`, 'change', 2],
			[`${DIR}/Broken.base`, 'skip', 0],
			[`${DIR}/Clash.base`, 'skip', 0],
		]);
		expect(await readFile(BASE)).toBe(original);
	});

	it('applies only the checked file and makes a restore copy first', async function () {
		await openAndScan('status', 'state');
		// Uncheck every file except Projects.base.
		for (const cb of await browser.$$('.bpr-modal .bpr-check')) {
			const label = await cb.getAttribute('aria-label');
			if (label !== `Apply to ${BASE}`) await cb.click();
		}
		await browser.$('.bpr-modal button.bpr-apply').click();
		await waitState('applied');
		const text = (await readFile(BASE))!;
		expect(text).toContain('note.state != "archived"');
		expect(text).toContain('property: note.state');
		expect(text).toContain('formula.overdue');
		expect(await readFile(`${DIR}/Reading list.base`)).toContain('note["status"]');
		const copies = await browser.executeObsidian(({ app }) =>
			app.vault
				.getFiles()
				.filter((f) => f.path.startsWith('Bases Property Repair/Restore copies/Projects '))
				.map((f) => f.path),
		);
		expect(copies.length).toBeGreaterThanOrEqual(1);
		expect(await readFile(copies[copies.length - 1]!)).toBe(original);
		const result = await browser.$(`.bpr-modal .bpr-file[data-path="${BASE}"] .bpr-result`).getText();
		expect(result).toContain('Written. Restore copy');
	});

	it('does not write a file that changed after the preview', async function () {
		await openAndScan('status', 'state');
		const edited = original + '# edited after the preview\n';
		await writeFile(BASE, edited);
		await browser.waitUntil(async () => (await readFile(BASE)) === edited, { timeout: 10000 });
		await browser.$('.bpr-modal button.bpr-apply').click();
		await waitState('applied');
		expect(await readFile(BASE)).toBe(edited);
		const result = await browser.$(`.bpr-modal .bpr-file[data-path="${BASE}"] .bpr-result`).getText();
		expect(result).toContain('changed after the preview');
	});

	it('shows a reason for a bad map and writes nothing', async function () {
		await browser.executeObsidianCommand(`${pluginId}:repair`);
		await waitState('idle');
		const inputs = await browser.$$('.bpr-modal .bpr-pair input');
		await inputs[0]!.setValue('status');
		await inputs[1]!.setValue('status');
		await browser.$('.bpr-modal button.bpr-scan').click();
		await waitState('error');
		expect(await browser.$('.bpr-modal .bpr-message').getText()).toContain('same as the old key');
	});
});
