import {App, ButtonComponent, Modal, Setting} from 'obsidian';
import VaultCryptPlugin from '../main';
import {ProfileConfig, validateProfileName, VaultCryptSettings} from '../settings';
import {KdbxVersion} from '../kdbx-service';

export class AddProfileModal extends Modal {
	private onDone: () => void;
	private plugin: VaultCryptPlugin;
	private name = "";
	private version: KdbxVersion = 4;
	private password = "";
	private confirmPassword = "";
	private addToKeyring = false;
	private keyringPassword = "";
	private errorEl!: HTMLParagraphElement;
	private isSubmitting = false;
	private submitBtn!: ButtonComponent;

	constructor(app: App, plugin: VaultCryptPlugin, onDone: () => void) {
		super(app);
		this.plugin = plugin;
		this.onDone = onDone;
		this.addToKeyring = plugin.settings.keyringEnabled;
	}

	onOpen() {
		const {contentEl} = this;
		this.titleEl.setText("Add profile");

		new Setting(contentEl)
			.setName("Profile name")
			.setDesc("Alphanumeric and hyphens only (for example, my-profile)")
			.addText(text => text
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				.setPlaceholder("my-profile")
				.onChange(value => {
					this.name = value;
				}));

		new Setting(contentEl)
			.setName("Database version")
			.addDropdown(dd => dd
				.addOption("4", "Version 4 (recommended)")
				.addOption("3", "Version 3")
				.setValue("4")
				.onChange(value => {
					this.version = parseInt(value) as KdbxVersion;
				}));

		new Setting(contentEl)
			.setName("Master password")
			.addText(text => {
				text.inputEl.type = "password";
				text.setPlaceholder("Enter master password")
					.onChange(value => {
						this.password = value;
					});
			});

		new Setting(contentEl)
			.setName("Confirm password")
			.addText(text => {
				text.inputEl.type = "password";
				text.setPlaceholder("Confirm master password")
					.onChange(value => {
						this.confirmPassword = value;
					});
			});

		// Keyring integration (only shown when keyring is enabled)
		if (this.plugin.settings.keyringEnabled) {
			const keyringPasswordSetting = new Setting(contentEl)
				.setName("Keyring master password")
				.addText(text => {
					text.inputEl.type = "password";
					text.setPlaceholder("Enter keyring password")
						.onChange(value => {
							this.keyringPassword = value;
						});
				});

			const updateKeyringVisibility = (show: boolean) => {
				keyringPasswordSetting.settingEl.toggle(show);
			};
			updateKeyringVisibility(this.addToKeyring);

			new Setting(contentEl)
				.setName("Add to keyring")
				.setDesc("Enables unified unlock, but compromising the keyring exposes all managed profile passwords at once.")
				.addToggle(toggle => toggle
					.setValue(this.addToKeyring)
					.onChange(value => {
						this.addToKeyring = value;
						updateKeyringVisibility(value);
					}));

			// Move the keyring password setting after the toggle visually
			contentEl.appendChild(keyringPasswordSetting.settingEl);
		}

		this.errorEl = contentEl.createEl("p", {cls: "mod-warning"});
		this.errorEl.addClass("vaultcrypt-hidden");

		new Setting(contentEl)
			.addButton(btn => btn.setButtonText("Cancel").onClick(() => this.close()))
			.addButton(btn => {
				this.submitBtn = btn;
				btn.setButtonText("Add profile")
					.setCta()
					.onClick(() => this.submit());
			});
	}

	private showError(msg: string) {
		this.errorEl.textContent = msg;
		this.errorEl.removeClass("vaultcrypt-hidden");
	}

	private async submit() {
		if (this.isSubmitting) return;

		// Synchronous validation — no guard needed for early exits
		const existingNames = Object.keys(this.plugin.settings.profiles);
		const nameError = validateProfileName(this.name, existingNames);
		if (nameError) {
			this.showError(nameError);
			return;
		}
		if (!this.password) {
			this.showError("Master password is required.");
			return;
		}
		if (this.password !== this.confirmPassword) {
			this.showError("Passwords do not match.");
			return;
		}
		if (this.addToKeyring && !this.keyringPassword) {
			this.showError("Keyring master password is required to add this profile to the keyring.");
			return;
		}

		this.isSubmitting = true;
		this.submitBtn.setDisabled(true);
		try {
			// Preflight the keyring write before creating the profile so a bad
			// keyring password doesn't leave a half-created profile behind
			if (this.addToKeyring) {
				await this.plugin.keyringService.setProfilePassword(
					this.plugin.settings.masterKeyringPath,
					this.keyringPassword,
					this.name.toLowerCase(),
					this.password,
				);
			}

			try {
				await this.plugin.addProfile(this.name, this.password, this.version);
			} catch (err) {
				// Roll back keyring entry if profile creation failed
				if (this.addToKeyring) {
					await this.plugin.keyringService.removeProfilePassword(
						this.plugin.settings.masterKeyringPath,
						this.keyringPassword,
						this.name.toLowerCase(),
					).catch(e => console.error('[VaultCrypt] Failed to roll back keyring entry', e));
				}
				throw err;
			}

			// Mark as managed now that both the keyring write and profile creation succeeded
			if (this.addToKeyring) {
				const profileId = this.name.toLowerCase();
				this.plugin.patchSettings((s: VaultCryptSettings) => {
					const profile = s.profiles[profileId];
					if (profile) profile.managedByKeyring = true;
				});
			}

			this.close();
			this.onDone();
		} catch (e) {
			this.showError(`Error creating profile: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.isSubmitting = false;
			this.submitBtn.setDisabled(false);
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

export class EditProfileModal extends Modal {
	private onDone: () => void;
	private plugin: VaultCryptPlugin;
	private profileName: string;
	private config: ProfileConfig;
	private autoLockMinutes: number;
	private defaultField: string;
	private errorEl!: HTMLParagraphElement;
	private isSubmitting = false;
	private submitBtn!: ButtonComponent;

	constructor(app: App, profileName: string, config: ProfileConfig, plugin: VaultCryptPlugin, onDone: () => void) {
		super(app);
		this.profileName = profileName;
		this.config = config;
		this.plugin = plugin;
		this.onDone = onDone;
		this.autoLockMinutes = config.autoLockMinutes;
		this.defaultField = config.defaultField;
	}

	onOpen() {
		const {contentEl} = this;
		this.titleEl.setText("Edit profile");

		new Setting(contentEl).setName("Profile name").setDesc(this.profileName);
		// eslint-disable-next-line obsidianmd/ui/sentence-case
		new Setting(contentEl).setName("KDBX version").setDesc(String(this.config.kdbxVersion));
		new Setting(contentEl).setName("Path").setDesc(this.config.path);

		new Setting(contentEl)
			.setName("Auto-lock (minutes)")
			.setDesc("0 = use global default")
			.addText(text => text
				.setValue(String(this.autoLockMinutes))
				.onChange(value => {
					const parsed = parseInt(value);
					this.autoLockMinutes = isNaN(parsed) ? 0 : Math.max(0, parsed);
				}));

		new Setting(contentEl)
			.setName("Default field")
			.setDesc("The field to copy when no field is specified (for example, password or username)")
			.addText(text => text
				.setValue(this.defaultField)
				.onChange(value => {
					this.defaultField = value.trim() || 'Password';
				}));

		this.errorEl = contentEl.createEl("p", {cls: "mod-warning"});
		this.errorEl.addClass("vaultcrypt-hidden");

		new Setting(contentEl)
			.addButton(btn => btn.setButtonText("Cancel").onClick(() => this.close()))
			.addButton(btn => {
				this.submitBtn = btn;
				btn.setButtonText("Save")
					.setCta()
					.onClick(() => this.submit());
			});
	}

	private async submit() {
		if (this.isSubmitting) return;

		this.isSubmitting = true;
		this.submitBtn.setDisabled(true);
		try {
			await this.plugin.editProfile(this.profileName, {
				autoLockMinutes: this.autoLockMinutes,
				defaultField: this.defaultField,
			});
			this.close();
			this.onDone();
		} catch (e) {
			this.errorEl.textContent = `Error saving: ${e instanceof Error ? e.message : String(e)}`;
			this.errorEl.removeClass("vaultcrypt-hidden");
		} finally {
			this.isSubmitting = false;
			this.submitBtn.setDisabled(false);
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

export class RenameProfileModal extends Modal {
	private onDone: () => void;
	private plugin: VaultCryptPlugin;
	private currentName: string;
	private newName: string;
	private keyringPassword = "";
	private isManagedByKeyring: boolean;
	private errorEl!: HTMLParagraphElement;
	private isSubmitting = false;
	private submitBtn!: ButtonComponent;

	constructor(app: App, currentName: string, plugin: VaultCryptPlugin, onDone: () => void) {
		super(app);
		this.currentName = currentName;
		this.newName = currentName;
		this.plugin = plugin;
		this.onDone = onDone;
		this.isManagedByKeyring = plugin.settings.profiles[currentName.toLowerCase()]?.managedByKeyring ?? false;
	}

	onOpen() {
		const {contentEl} = this;
		this.titleEl.setText("Rename profile");

		new Setting(contentEl)
			.setName("New name")
			.addText(text => text
				.setValue(this.currentName)
				.onChange(value => {
					this.newName = value;
				}));

		if (this.isManagedByKeyring) {
			new Setting(contentEl)
				.setName("Keyring master password")
				.setDesc("Required to update the keyring entry")
				.addText(text => {
					text.inputEl.type = "password";
					text.setPlaceholder("Enter keyring password")
						.onChange(value => {
							this.keyringPassword = value;
						});
				});
		}

		this.errorEl = contentEl.createEl("p", {cls: "mod-warning"});
		this.errorEl.addClass("vaultcrypt-hidden");

		new Setting(contentEl)
			.addButton(btn => btn.setButtonText("Cancel").onClick(() => this.close()))
			.addButton(btn => {
				this.submitBtn = btn;
				btn.setButtonText("Rename")
					.setCta()
					.onClick(() => this.submit());
			});
	}

	private showError(msg: string) {
		this.errorEl.textContent = msg;
		this.errorEl.removeClass("vaultcrypt-hidden");
	}

	private async submit() {
		if (this.isSubmitting) return;

		// Synchronous validation — exclude current name so a no-op rename isn't blocked
		const existingNames = Object.keys(this.plugin.settings.profiles)
			.filter(n => n.toLowerCase() !== this.currentName.toLowerCase());
		const nameError = validateProfileName(this.newName, existingNames);
		if (nameError) {
			this.showError(nameError);
			return;
		}

		const normalizedCurrentName = this.currentName.toLowerCase();
		const normalizedNewName = this.newName.toLowerCase();
		if (normalizedNewName === normalizedCurrentName) {
			this.showError("Enter a different profile name.");
			return;
		}

		if (this.isManagedByKeyring && !this.keyringPassword) {
			this.showError("Keyring master password is required to rename a keyring-managed profile.");
			return;
		}

		this.isSubmitting = true;
		this.submitBtn.setDisabled(true);
		try {
			// Rename keyring entry first; roll it back if the profile rename fails
			if (this.isManagedByKeyring) {
				await this.plugin.keyringService.renameProfileEntry(
					this.plugin.settings.masterKeyringPath,
					this.keyringPassword,
					normalizedCurrentName,
					normalizedNewName,
				);
			}
			try {
				await this.plugin.renameProfile(this.currentName, this.newName);
			} catch (e) {
				if (this.isManagedByKeyring) {
					try {
						await this.plugin.keyringService.renameProfileEntry(
							this.plugin.settings.masterKeyringPath,
							this.keyringPassword,
							normalizedNewName,
							normalizedCurrentName,
						);
					} catch (rollbackErr) {
						console.error('[VaultCrypt] Failed to roll back keyring rename:', rollbackErr);
					}
				}
				throw e;
			}
			this.close();
			this.onDone();
		} catch (e) {
			this.showError(`Error renaming: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.isSubmitting = false;
			this.submitBtn.setDisabled(false);
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

export class DeleteProfileModal extends Modal {
	private onDone: () => void;
	private plugin: VaultCryptPlugin;
	private profileName: string;
	private config: ProfileConfig;
	private deleteFile = false;
	private keyringPassword = "";
	private errorEl!: HTMLParagraphElement;
	private isSubmitting = false;
	private submitBtn!: ButtonComponent;

	constructor(app: App, profileName: string, config: ProfileConfig, plugin: VaultCryptPlugin, onDone: () => void) {
		super(app);
		this.profileName = profileName;
		this.config = config;
		this.plugin = plugin;
		this.onDone = onDone;
	}

	onOpen() {
		const {contentEl} = this;
		this.titleEl.setText("Delete profile");

		contentEl.createEl("p", {
			text: `Are you sure you want to delete the profile '${this.profileName}'? This action cannot be undone.`
		});

		new Setting(contentEl)
			.setName(`Also delete ${this.config.path} from disk`)
			.addToggle(toggle => toggle
				.setValue(false)
				.onChange(value => {
					this.deleteFile = value;
				}));

		if (this.config.managedByKeyring) {
			new Setting(contentEl)
				.setName("Keyring master password")
				.setDesc("Required to remove this profile from the keyring")
				.addText(text => {
					text.inputEl.type = "password";
					text.setPlaceholder("Enter keyring password")
						.onChange(value => {
							this.keyringPassword = value;
						});
				});
		}

		this.errorEl = contentEl.createEl("p", {cls: "mod-warning"});
		this.errorEl.addClass("vaultcrypt-hidden");

		new Setting(contentEl)
			.addButton(btn => btn.setButtonText("Cancel").onClick(() => this.close()))
			.addButton(btn => {
				this.submitBtn = btn;
				btn.setButtonText("Delete")
					.setWarning()
					.onClick(() => this.confirm());
			});
	}

	private async confirm() {
		if (this.isSubmitting) return;

		if (this.config.managedByKeyring && !this.keyringPassword) {
			this.showError("Keyring master password is required to remove the profile from the keyring.");
			return;
		}

		this.isSubmitting = true;
		this.submitBtn.setDisabled(true);
		try {
			// Delete profile first so a failure doesn't leave us without a keyring entry
			await this.plugin.deleteProfile(this.profileName, this.deleteFile);

			// Clean up keyring entry after successful deletion; log but don't
			// fail if the keyring removal itself errors
			if (this.config.managedByKeyring) {
				try {
					await this.plugin.keyringService.removeProfilePassword(
						this.plugin.settings.masterKeyringPath,
						this.keyringPassword,
						this.profileName.toLowerCase(),
					);
				} catch (e) {
					console.error('[VaultCrypt] Failed to remove keyring entry after profile deletion', e);
				}
			}
			this.close();
			this.onDone();
		} catch (e) {
			this.showError(`Error deleting: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.isSubmitting = false;
			this.submitBtn.setDisabled(false);
		}
	}

	private showError(msg: string) {
		this.errorEl.textContent = msg;
		this.errorEl.removeClass("vaultcrypt-hidden");
	}

	onClose() {
		this.contentEl.empty();
	}
}
