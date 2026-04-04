import {App, ButtonComponent, Modal, Notice, Setting, TFolder} from 'obsidian';
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

	/** Strip trailing slashes and surrounding whitespace for consistent comparisons. */
	private normalizeDir(path: string): string {
		return path.trim().replace(/\/+$/, '');
	}

	constructor(app: App, plugin: VaultCryptPlugin, onDone: () => void) {
		super(app);
		this.plugin = plugin;
		this.onDone = onDone;
		this.newPath = this.normalizeDir(plugin.settings.general.vaultCryptDir);
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
					this.newPath = this.normalizeDir(value);
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
						// Snapshot mutable fields at click time to avoid async state drift
						const targetPath = this.newPath;
						const moveFiles = this.moveFiles;
						try {
							if (moveFiles) {
								await this.plugin.profileService.moveVaultDir(targetPath);
								new Notice(`VaultCrypt: directory moved to "${targetPath}".`);
							} else {
								// Create the directory first; if this throws, settings are NOT patched
								// and the catch block re-enables the button without committing a bad path.
								// Check existence first — mkdir throws if the directory already exists.
								const existing = this.plugin.app.vault.getAbstractFileByPath(targetPath);
								if (existing && !(existing instanceof TFolder)) {
									throw new Error(`Target path "${targetPath}" exists and is not a folder.`);
								}
								if (!existing) {
									await this.plugin.app.vault.adapter.mkdir(targetPath);
								}
								this.plugin.patchSettings(s => {
									s.general.vaultCryptDir = targetPath;
								});
							}
						} catch (e) {
							if (!moveFiles) {
								// moveVaultDir shows its own Notice; only surface mkdir errors here
								const msg = e instanceof Error ? e.message : String(e);
								new Notice(`VaultCrypt: failed to create directory — ${msg}`);
							}
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
		const current = this.normalizeDir(this.plugin.settings.general.vaultCryptDir);
		const isUnchanged = this.newPath === current;
		const isEmpty = this.newPath.length === 0;
		this.confirmBtn?.setDisabled(isUnchanged || isEmpty);
	}

	onClose() {
		this.contentEl.empty();
	}
}
