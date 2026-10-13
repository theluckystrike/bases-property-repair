import { ButtonComponent, Modal, Notice, Setting, type App } from 'obsidian';
import { isPro } from './pro';
import type { ApplyResult, FilePlan } from './repair';
import type { JournalEntry, RenamePair } from './settings';
import type BasesPropertyRepairPlugin from './main';

/** data-state of the repair modal, for tests: idle, scanned, applied or error. */
export type ModalState = 'idle' | 'busy' | 'scanned' | 'applied' | 'error';

const STATUS_TEXT: Record<FilePlan['status'], string> = { change: 'Changes found', none: 'No reference', skip: 'Skipped' };

export class RepairModal extends Modal {
	pairs: RenamePair[] = [{ from: '', to: '' }];
	plans: FilePlan[] = [];
	checked = new Set<string>();
	results: ApplyResult[] = [];
	/** The pairs of the last scan. Apply records these in the journal, also when the fields changed after the scan. */
	private scannedPairs: RenamePair[] = [];
	private pairsEl!: HTMLElement;
	private mapEl!: HTMLElement;
	private msgEl!: HTMLElement;
	private resultsEl!: HTMLElement;
	private applyButton!: ButtonComponent;
	private scanButton!: ButtonComponent;

	constructor(
		app: App,
		private readonly plugin: BasesPropertyRepairPlugin,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle('Repair property references');
		this.modalEl.addClass('bpr-modal');
		const { contentEl } = this;
		contentEl.createEl('p', { cls: 'bpr-intro', text: 'Enter the old property key and the new key. The scan reads each .base file and shows the changes. Nothing is written until you select apply.' });
		this.mapEl = contentEl.createDiv({ cls: 'bpr-maps' });
		this.pairsEl = contentEl.createDiv({ cls: 'bpr-pairs' });
		const buttons = new Setting(contentEl).setClass('bpr-buttons');
		buttons.addButton((b) => {
			this.scanButton = b;
			b.setButtonText('Scan base files')
				.setClass('bpr-scan')
				.setCta()
				.onClick(() => void this.scan());
		});
		buttons.addButton((b) => {
			this.applyButton = b;
			b.setButtonText('Apply checked changes')
				.setClass('bpr-apply')
				.setDisabled(true)
				.onClick(() => void this.apply());
		});
		this.msgEl = contentEl.createDiv({ cls: 'bpr-message' });
		this.resultsEl = contentEl.createDiv({ cls: 'bpr-results' });
		this.renderMaps();
		this.renderPairs();
		this.setState('idle');
	}

	onClose(): void {
		this.contentEl.empty();
	}

	setState(state: ModalState): void {
		this.modalEl.dataset.state = state;
	}

	setPairs(pairs: RenamePair[]): void {
		this.pairs = pairs.map((p) => ({ ...p }));
		this.renderPairs();
	}

	private renderMaps(): void {
		const el = this.mapEl;
		el.empty();
		if (!isPro()) {
			el.createDiv({ cls: 'bpr-pro-note', text: 'Pro: save named rename maps with one or more key pairs.' });
			return;
		}
		let name = '';
		const s = new Setting(el).setName('Saved maps');
		s.addDropdown((d) => {
			d.addOption('', this.plugin.settings.maps.length ? 'Load a map' : 'No saved map');
			for (const m of this.plugin.settings.maps) d.addOption(m.name, `${m.name} (${m.pairs.length})`);
			d.onChange((v) => {
				const m = this.plugin.settings.maps.find((x) => x.name === v);
				if (m) this.setPairs(m.pairs);
			});
		});
		s.addText((t) => t.setPlaceholder('Map name').onChange((v) => (name = v)));
		s.addButton((b) =>
			b.setButtonText('Save map').onClick(async () => {
				const problem = await this.plugin.saveMap(name, this.pairs);
				new Notice(problem ?? `Saved the map "${name.trim()}".`);
				if (!problem) this.renderMaps();
			}),
		);
	}

	private renderPairs(): void {
		const el = this.pairsEl;
		el.empty();
		this.pairs.forEach((pair, i) => {
			const s = new Setting(el).setName(this.pairs.length > 1 ? `Pair ${i + 1}` : 'Rename').setClass('bpr-pair');
			s.addText((t) =>
				t
					.setPlaceholder('Old key, for example status')
					.setValue(pair.from)
					.onChange((v) => (pair.from = v)),
			);
			s.addText((t) =>
				t
					.setPlaceholder('New key, for example state')
					.setValue(pair.to)
					.onChange((v) => (pair.to = v)),
			);
			if (this.pairs.length > 1)
				s.addExtraButton((b) =>
					b
						.setIcon('x')
						.setTooltip('Remove this pair')
						.onClick(() => {
							this.pairs.splice(i, 1);
							this.renderPairs();
						}),
				);
		});
		if (isPro())
			new Setting(el).addButton((b) =>
				b.setButtonText('Add a pair').onClick(() => {
					this.pairs.push({ from: '', to: '' });
					this.renderPairs();
				}),
			);
	}

	async scan(): Promise<FilePlan[]> {
		this.setState('busy');
		this.results = [];
		this.scanButton.setDisabled(true);
		try {
			const pairs = this.pairs.map((p) => ({ ...p }));
			this.plans = await this.plugin.scan(pairs);
			this.scannedPairs = pairs;
			this.checked = new Set(this.plans.filter((p) => p.status === 'change').map((p) => p.path));
			this.renderPlans();
			this.setState('scanned');
		} catch (e) {
			this.plans = [];
			this.checked.clear();
			this.resultsEl.empty();
			this.msgEl.setText(e instanceof Error ? e.message : String(e));
			this.setState('error');
		} finally {
			this.scanButton.setDisabled(false);
			this.applyButton.setDisabled(this.checked.size === 0);
		}
		return this.plans;
	}

	async apply(): Promise<ApplyResult[]> {
		this.setState('busy');
		this.applyButton.setDisabled(true);
		try {
			this.results = await this.plugin.apply(this.plans, this.checked, this.scannedPairs);
		} catch (e) {
			this.msgEl.setText(e instanceof Error ? e.message : String(e));
			this.setState('error');
			this.applyButton.setDisabled(this.checked.size === 0);
			return [];
		}
		const written = this.results.filter((r) => r.status === 'written').length;
		const msg = `Wrote ${written} of ${this.results.length} checked files.${written < this.results.length ? ' See the reasons below.' : ''}`;
		new Notice(msg);
		this.checked.clear();
		this.renderPlans();
		this.msgEl.setText(msg);
		this.setState('applied');
		return this.results;
	}

	private renderPlans(): void {
		const el = this.resultsEl;
		el.empty();
		const count = (s: FilePlan['status']) => this.plans.filter((p) => p.status === s).length;
		this.msgEl.setText(`Scanned ${this.plans.length} Base files: ${count('change')} with changes, ${count('skip')} skipped, ${count('none')} with no reference.`);
		const byPath = new Map(this.results.map((r) => [r.path, r]));
		for (const plan of [...this.plans].sort((a, b) => order(a) - order(b))) {
			const box = el.createDiv({ cls: `bpr-file is-${plan.status}` });
			box.dataset.path = plan.path;
			const head = box.createDiv({ cls: 'bpr-file-head' });
			if (plan.status === 'change' && !byPath.has(plan.path)) {
				const cb = head.createEl('input', { type: 'checkbox', cls: 'bpr-check', attr: { 'aria-label': `Apply to ${plan.path}` } });
				cb.checked = this.checked.has(plan.path);
				cb.addEventListener('change', () => {
					if (cb.checked) this.checked.add(plan.path);
					else this.checked.delete(plan.path);
					this.applyButton.setDisabled(this.checked.size === 0);
				});
			}
			head.createSpan({ cls: 'bpr-path', text: plan.path });
			head.createSpan({ cls: 'bpr-status', text: STATUS_TEXT[plan.status] });
			const result = byPath.get(plan.path);
			if (result) box.createDiv({ cls: `bpr-result is-${result.status}`, text: result.message });
			if (plan.reason) box.createDiv({ cls: 'bpr-reason', text: plan.reason });
			if (plan.changes.length > 0) {
				const list = box.createEl('ul', { cls: 'bpr-changes' });
				for (const c of plan.changes) {
					const li = list.createEl('li');
					li.createSpan({ cls: 'bpr-where', text: c.where });
					li.createEl('code', { cls: 'bpr-before', text: c.before });
					li.createSpan({ cls: 'bpr-arrow', text: '→' });
					li.createEl('code', { cls: 'bpr-after', text: c.after });
				}
			}
			if (plan.notes.length > 0) {
				const list = box.createEl('ul', { cls: 'bpr-notes' });
				for (const n of plan.notes) list.createEl('li', { cls: `bpr-note is-${n.kind}`, text: `${n.where}: ${n.text}` });
			}
		}
	}
}

function order(p: FilePlan): number {
	return p.status === 'change' ? 0 : p.status === 'skip' ? 1 : 2;
}

export class JournalModal extends Modal {
	constructor(
		app: App,
		private readonly plugin: BasesPropertyRepairPlugin,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle('Change journal');
		this.modalEl.addClass('bpr-modal', 'bpr-journal');
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	render(): void {
		const el = this.contentEl;
		el.empty();
		const entries = [...this.plugin.settings.journal].reverse();
		el.createEl('p', { cls: 'bpr-intro', text: `${entries.length} writes in this vault, newest first. Restore writes the restore copy back only while the file still has the text that the plugin wrote.` });
		for (const e of entries) this.renderEntry(el, e);
		this.modalEl.dataset.state = 'ready';
	}

	private renderEntry(el: HTMLElement, e: JournalEntry): void {
		const s = new Setting(el)
			.setName(`${e.path}${e.restored ? ' (restored)' : ''}`)
			.setDesc(`${new Date(e.time).toLocaleString()}: ${e.pairs.map((p) => `${p.from} → ${p.to}`).join(', ')}. Copy: ${e.copy}`)
			.setClass('bpr-journal-entry');
		s.addButton((b) =>
			b
				.setButtonText('Restore')
				.setDisabled(e.restored)
				.onClick(async () => {
					new Notice(await this.plugin.restore(e));
					this.render();
				}),
		);
	}
}
