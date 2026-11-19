import {Modal, Notice, Setting, type ButtonComponent} from 'obsidian';
import type VaultCryptPlugin from '../main';
import {scanForVaults, type ImportableVault, type VaultImportSelection} from '../vault-import';

export class VaultImportFlow {
	private readonly lifetime = new AbortController();
	private scanning = false;
	private modal?: VaultImportModal;

	constructor(private plugin: VaultCryptPlugin) {
		plugin.register(() => {
			this.lifetime.abort();
			this.modal?.close();
		});
	}

	registerStartupScan(): void {
		this.plugin.app.workspace.onLayoutReady(() => {
			if (!this.plugin.settings.general.hasScannedForVaults) void this.scan(true);
		});
	}

	open(onImported: () => void): Promise<void> {
		return this.scan(false, onImported);
	}

	private async scan(automatic: boolean, onImported?: () => void): Promise<void> {
		const {signal} = this.lifetime;
		if (signal.aborted || this.scanning || this.modal) return;
		this.scanning = true;
		try {
			const {directory, candidates, unreadable} = await scanForVaults(this.plugin.app, this.plugin.settings, signal);
			if (signal.aborted) return;
			if (directory !== this.plugin.settings.general.vaultCryptDir) {
				new Notice('The storage directory changed. Open VaultCrypt settings to scan again.');
				return;
			}
			if (unreadable === 1) new Notice(`Could not read one database file in ${directory}.`);
			else if (unreadable > 1) new Notice(`Could not read ${unreadable} database files in ${directory}.`);
			if (candidates.length > 0) {
				const modal = new VaultImportModal(this.plugin, directory, candidates, onImported, () => { this.modal = undefined; });
				modal.open();
				this.modal = modal;
			} else if (!automatic && unreadable === 0) {
				new Notice(`No new KDBX databases found in ${directory}.`);
			}
			if (unreadable === 0 && !this.plugin.settings.general.hasScannedForVaults) {
				this.plugin.patchSettings(settings => { settings.general.hasScannedForVaults = true; });
			}
		} catch (error) {
			if (signal.aborted) return;
			console.error('[VaultCrypt] Could not scan the storage directory', error);
			new Notice('Could not scan the storage directory. Open VaultCrypt settings to try again.');
		} finally {
			this.scanning = false;
		}
	}
}

class VaultImportModal extends Modal {
	private readonly lifetime = new AbortController();
	private readonly selected = new Map<ImportableVault, HTMLInputElement>();
	private submitting = false;
	private submitButton!: ButtonComponent;
	private errorEl!: HTMLParagraphElement;

	constructor(
		private plugin: VaultCryptPlugin,
		private directory: string,
		private candidates: ImportableVault[],
		private onImported: (() => void) | undefined,
		private onDismiss: () => void,
	) {
		super(plugin.app);
	}

	onOpen(): void {
		const {contentEl} = this;
		this.titleEl.setText('Import vaults');
		contentEl.createEl('p', {
			text: 'Select the databases to import and enter their passwords. VaultCrypt supports databases that use a password alone.',
		});

		for (const candidate of this.candidates) {
			const row = new Setting(contentEl)
				.setName(candidate.path)
				.setDesc(`KDBX version ${candidate.version}`)
				.addText(text => {
					text.setValue(candidate.name).onChange(value => { candidate.name = value.trim(); });
					text.inputEl.setAttribute('aria-label', `Profile name for ${candidate.path}`);
				});
			const passwordRow = new Setting(contentEl).setName('Database password');
			passwordRow.settingEl.addClass('vaultcrypt-hidden');
			passwordRow.addText(text => {
				const input = text.inputEl;
				input.type = 'password';
				input.setAttribute('aria-label', `Database password for ${candidate.path}`);
				row.addToggle(toggle => toggle
					.setTooltip(`Import ${candidate.path}`)
					.onChange(selected => {
						if (selected) this.selected.set(candidate, input);
						else {
							input.value = '';
							this.selected.delete(candidate);
						}
						passwordRow.settingEl.toggleClass('vaultcrypt-hidden', !selected);
						this.submitButton.setDisabled(this.submitting || this.selected.size === 0);
					}));
			});
		}
		this.errorEl = contentEl.createEl('p', {cls: 'mod-warning'});
		this.errorEl.setAttribute('role', 'alert');
		new Setting(contentEl)
			.addButton(button => button.setButtonText('Cancel').onClick(() => this.close()))
			.addButton(button => {
				this.submitButton = button;
				button.setButtonText('Import selected').setCta().setDisabled(true).onClick(() => this.submit());
			});
	}

	private async submit(): Promise<void> {
		if (this.submitting || this.selected.size === 0) return;
		const selections: VaultImportSelection[] = Array.from(this.selected, ([{path, name}, input]) => ({
			path, name, password: input.value,
		}));
		const {signal} = this.lifetime;
		this.submitting = true;
		this.submitButton.setDisabled(true).setButtonText('Importing...');
		this.errorEl.setText('');
		try {
			await this.plugin.importVaults(this.directory, selections, signal);
		} catch (error) {
			if (!signal.aborted) {
				this.errorEl.setText(error instanceof Error ? error.message : String(error));
				this.submitting = false;
				this.submitButton.setDisabled(this.selected.size === 0).setButtonText('Import selected');
			}
			return;
		}
		if (signal.aborted) return;
		new Notice(selections.length === 1 ? 'Imported 1 vault.' : `Imported ${selections.length} vaults.`);
		this.close();
		this.onImported?.();
	}

	onClose(): void {
		this.lifetime.abort();
		for (const input of this.selected.values()) input.value = '';
		this.selected.clear();
		this.contentEl.empty();
		this.onDismiss();
	}
}
