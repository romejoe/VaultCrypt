import {App, Modal, Notice, Setting} from 'obsidian';
import VaultCryptPlugin from '../main';

export class DeleteSecretModal extends Modal {
	private plugin: VaultCryptPlugin;
	private profileId: string;
	private entryPath: string;
	private isSubmitting = false;

	constructor(app: App, plugin: VaultCryptPlugin, profileId: string, entryPath: string) {
		super(app);
		this.plugin = plugin;
		this.profileId = profileId;
		this.entryPath = entryPath;
	}

	onOpen() {
		const {contentEl} = this;
		this.titleEl.setText('Delete entry');

		contentEl.createEl('p', {
			text: `Are you sure you want to delete "${this.entryPath}" from profile "${this.profileId}"?`,
		});
		contentEl.createEl('p', {
			cls: 'mod-warning',
			text: 'This action cannot be undone. Inline references to this entry will show a "not found" indicator.',
		});

		new Setting(contentEl)
			.addButton(btn => btn.setButtonText('Cancel').onClick(() => this.close()))
			.addButton(btn => btn
				.setButtonText('Delete')
				.setWarning()
				.onClick(() => {
					this.submit().catch(e => console.error('[VaultCrypt] DeleteSecretModal error', e));
				}));
	}

	private async submit() {
		if (this.isSubmitting) return;
		this.isSubmitting = true;

		try {
			const config = this.plugin.settings.profiles[this.profileId];
			if (!config) {
				new Notice('Profile not found.');
				return;
			}

			await this.plugin.sessionService.deleteEntry(
				this.profileId,
				this.entryPath,
				config.path,
			);

			this.plugin.refreshChips();
			new Notice(`Entry "${this.entryPath}" deleted`);
			this.close();
		} catch (e) {
			console.error('[VaultCrypt] DeleteSecretModal submit error', e);
			new Notice(`Error: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.isSubmitting = false;
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
