import {App, ButtonComponent, Modal, Notice, Setting} from 'obsidian';
import VaultCryptPlugin from '../main';

/**
 * Shown once on startup when the vault directory starts with a dot,
 * warning the user that Obsidian Sync will not sync hidden folders.
 */
export class SyncWarningModal extends Modal {
	private plugin: VaultCryptPlugin;

	constructor(app: App, plugin: VaultCryptPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const {contentEl} = this;
		const currentDir = this.plugin.settings.general.vaultCryptDir;

		// eslint-disable-next-line obsidianmd/ui/sentence-case
		this.titleEl.setText('VaultCrypt sync notice');

		contentEl.createEl('p', {
			text: `Your VaultCrypt folder ("${currentDir}") starts with a dot. `
				+ 'Obsidian Sync does not sync hidden folders, so your databases will not '
				+ 'be available on other synced devices.',
		});

		contentEl.createEl('p', {
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			text: 'Would you like to move it to "VaultCrypt" (a visible folder that Obsidian Sync will include)?',
		});

		new Setting(contentEl)
			.addButton(btn => btn
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				.setButtonText('Move to "VaultCrypt"')
				.setCta()
				.onClick(async () => {
					this.close();
					try {
						await this.plugin.profileService.moveVaultDir('VaultCrypt');
						// eslint-disable-next-line obsidianmd/ui/sentence-case
						new Notice('VaultCrypt: directory moved to "VaultCrypt".');
					} catch {
						// moveVaultDir already shows a Notice on failure
					}
					this.plugin.patchSettings(s => {
						s.general.hasSeenSyncWarning = true;
					});
				}))
			.addButton(btn => btn
				.setButtonText('Keep as is')
				.onClick(() => {
					this.plugin.patchSettings(s => {
						s.general.hasSeenSyncWarning = true;
					});
					this.close();
				}));
	}

	onClose() {
		this.contentEl.empty();
	}
}

/**
 * Lets the user change the VaultCrypt directory, with an option to move
 * existing files to the new location.
 */
export class MoveVaultDirModal extends Modal {
	private plugin: VaultCryptPlugin;
	private onDone: () => void;
	private newPath: string;
	private moveFiles = true;
	private confirmBtn!: ButtonComponent;

	constructor(app: App, plugin: VaultCryptPlugin, onDone: () => void) {
		super(app);
		this.plugin = plugin;
		this.onDone = onDone;
		this.newPath = plugin.settings.general.vaultCryptDir;
	}

	onOpen() {
		const {contentEl} = this;
		const currentDir = this.plugin.settings.general.vaultCryptDir;

		// eslint-disable-next-line obsidianmd/ui/sentence-case
		this.titleEl.setText('Change VaultCrypt directory');

		new Setting(contentEl)
			.setName('New directory path')
			.setDesc(`Current: ${currentDir}`)
			.addText(text => text
				.setValue(this.newPath)
				.onChange(value => {
					this.newPath = value.trim();
					this.updateConfirmState();
				}));

		new Setting(contentEl)
			.setName('Move existing files')
			.setDesc('Move .kdbx databases and other files from the current directory to the new location.')
			.addToggle(toggle => toggle
				.setValue(this.moveFiles)
				.onChange(value => {
					this.moveFiles = value;
				}));

		new Setting(contentEl)
			.addButton(btn => {
				this.confirmBtn = btn;
				btn
					.setButtonText('Confirm')
					.setCta()
					.onClick(async () => {
						btn.setDisabled(true);
						try {
							if (this.moveFiles) {
								await this.plugin.profileService.moveVaultDir(this.newPath);
								new Notice(`VaultCrypt: directory moved to "${this.newPath}".`);
							} else {
								this.plugin.patchSettings(s => {
									s.general.vaultCryptDir = this.newPath;
								});
							}
						} catch {
							btn.setDisabled(false);
							return;
						}
						this.close();
						this.onDone();
					});
			})
			.addButton(btn => btn
				.setButtonText('Cancel')
				.onClick(() => this.close()));

		this.updateConfirmState();
	}

	private updateConfirmState() {
		const isUnchanged = this.newPath === this.plugin.settings.general.vaultCryptDir;
		const isEmpty = this.newPath.length === 0;
		this.confirmBtn?.setDisabled(isUnchanged || isEmpty);
	}

	onClose() {
		this.contentEl.empty();
	}
}
