import {App, ButtonComponent, Modal, Notice, Setting} from "obsidian";
import VaultCryptPlugin from "./main";
import {ProfileConfig, validateProfileName, VaultCryptSettings} from "./settings";
import {KdbxVersion} from "./kdbx-service";
import {peek} from "@maverick-js/signals";

export class UnlockModal extends Modal {
	private plugin: VaultCryptPlugin;
	private selectedProfileId: string;
	private password = "";
	private errorEl!: HTMLParagraphElement;
	private isSubmitting = false;
	private submitBtn!: ButtonComponent;
	private onDone: ((profileId: string) => void) | undefined;

	constructor(
		app: App,
		plugin: VaultCryptPlugin,
		preselectedProfileId?: string,
		onDone?: (profileId: string) => void,
	) {
		super(app);
		this.plugin = plugin;
		this.onDone = onDone;
		// Pre-select provided profile, first locked profile, or first profile
		const profiles = plugin.settings.profiles;
		const lockedIds = Object.keys(profiles).filter(
			id => !plugin.sessionService.isUnlocked(id)
		);
		this.selectedProfileId =
			preselectedProfileId ??
			lockedIds[0] ??
			Object.keys(profiles)[0] ??
			"";
	}

	onOpen() {
		const {contentEl} = this;
		this.titleEl.setText("Unlock profile");

		const profiles = this.plugin.settings.profiles;
		const lockedIds = Object.keys(profiles).filter(
			id => !this.plugin.sessionService.isUnlocked(id)
		);

		new Setting(contentEl)
			.setName("Profile")
			.addDropdown(dd => {
				for (const id of lockedIds) {
					dd.addOption(id, id);
				}
				dd.setValue(this.selectedProfileId).onChange(value => {
					this.selectedProfileId = value;
				});
			});


		new Setting(contentEl)
			.setName("Master password")
			.addText(text => {
				text.inputEl.type = "password";
				text.inputEl.focus();
				text.setPlaceholder("Enter master password")
					.onChange(value => {
						this.password = value;
					});
				text.inputEl.addEventListener("keydown", (evt: KeyboardEvent) => {
					if (evt.key === "Enter") {
						this.submit().then().catch(() => {
							console.error("Failed to unlock vault");
						});
					}
				});
			});

		this.errorEl = contentEl.createEl("p", {cls: "mod-warning"});
		this.errorEl.addClass("vaultcrypt-hidden");

		new Setting(contentEl)
			.addButton(btn => btn.setButtonText("Cancel").onClick(() => this.close()))
			.addButton(btn => {
				this.submitBtn = btn;
				btn.setButtonText("Unlock")
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
		if (!this.selectedProfileId) {
			this.showError("No profile selected.");
			return;
		}
		if (!this.password) {
			this.showError("Master password is required.");
			return;
		}

		const config = this.plugin.settings.profiles[this.selectedProfileId];
		if (!config) {
			this.showError("Profile not found.");
			return;
		}

		this.isSubmitting = true;
		this.submitBtn.setDisabled(true);
		try {
			await this.plugin.sessionService.unlockProfile(this.selectedProfileId, config, this.password);
			this.close();
			this.onDone?.(this.selectedProfileId);
		} catch (e) {
			console.error(e);
			this.showError(`Incorrect password or corrupted database.`);
		} finally {
			this.isSubmitting = false;
			this.submitBtn.setDisabled(false);
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

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
						.onChange(value => { this.keyringPassword = value; });
				});

			const updateKeyringVisibility = (show: boolean) => {
				keyringPasswordSetting.settingEl.toggle(show);
			};
			updateKeyringVisibility(this.addToKeyring);

			new Setting(contentEl)
				.setName("Add to keyring")
				.setDesc("Store this profile's password in the keyring for unified unlock")
				.addToggle(toggle => toggle
					.setValue(this.addToKeyring)
					.onChange(value => {
						this.addToKeyring = value;
						updateKeyringVisibility(value);
					}));

			// Move the keyring password setting after the toggle visually
			contentEl.insertBefore(
				keyringPasswordSetting.settingEl,
				contentEl.lastElementChild,
			);
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
			await this.plugin.addProfile(this.name, this.password, this.version);

			// Store in keyring if requested
			if (this.addToKeyring) {
				const profileId = this.name.toLowerCase();
				await this.plugin.keyringService.setProfilePassword(
					this.plugin.settings.masterKeyringPath,
					this.keyringPassword,
					profileId,
					this.password,
				);
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
					this.defaultField = value;
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
						.onChange(value => { this.keyringPassword = value; });
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

		if (this.isManagedByKeyring && !this.keyringPassword) {
			this.showError("Keyring master password is required to rename a keyring-managed profile.");
			return;
		}

		this.isSubmitting = true;
		this.submitBtn.setDisabled(true);
		try {
			// Rename keyring entry first
			if (this.isManagedByKeyring) {
				await this.plugin.keyringService.renameProfileEntry(
					this.plugin.settings.masterKeyringPath,
					this.keyringPassword,
					this.currentName.toLowerCase(),
					this.newName.toLowerCase(),
				);
			}
			await this.plugin.renameProfile(this.currentName, this.newName);
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
			// Remove from keyring first (best-effort)
			if (this.config.managedByKeyring) {
				try {
					await this.plugin.keyringService.removeProfilePassword(
						this.plugin.settings.masterKeyringPath,
						this.keyringPassword,
						this.profileName.toLowerCase(),
					);
				} catch (e) {
					console.warn('[VaultCrypt] Failed to remove profile from keyring:', e);
				}
			}
			await this.plugin.deleteProfile(this.profileName, this.deleteFile);
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

// ── Keyring modals ──────────────────────────────────────────────────────────

export class SetupKeyringModal extends Modal {
	private plugin: VaultCryptPlugin;
	private onDone: () => void;
	private password = "";
	private confirmPassword = "";
	private errorEl!: HTMLParagraphElement;
	private isSubmitting = false;
	private submitBtn!: ButtonComponent;

	constructor(app: App, plugin: VaultCryptPlugin, onDone: () => void) {
		super(app);
		this.plugin = plugin;
		this.onDone = onDone;
	}

	onOpen() {
		const {contentEl} = this;
		this.titleEl.setText("Set up keyring");

		contentEl.createEl("p", {
			text: "Create a master password that will unlock all your profiles. " +
				"Profile passwords will be stored in an encrypted keyring file.",
		});

		new Setting(contentEl)
			.setName("Master password")
			.addText(text => {
				text.inputEl.type = "password";
				text.inputEl.focus();
				text.setPlaceholder("Enter master password")
					.onChange(value => { this.password = value; });
				text.inputEl.addEventListener("keydown", (evt: KeyboardEvent) => {
					if (evt.key === "Enter") void this.submit();
				});
			});

		new Setting(contentEl)
			.setName("Confirm password")
			.addText(text => {
				text.inputEl.type = "password";
				text.setPlaceholder("Confirm master password")
					.onChange(value => { this.confirmPassword = value; });
				text.inputEl.addEventListener("keydown", (evt: KeyboardEvent) => {
					if (evt.key === "Enter") void this.submit();
				});
			});

		this.errorEl = contentEl.createEl("p", {cls: "mod-warning"});
		this.errorEl.addClass("vaultcrypt-hidden");

		new Setting(contentEl)
			.addButton(btn => btn.setButtonText("Cancel").onClick(() => this.close()))
			.addButton(btn => {
				this.submitBtn = btn;
				btn.setButtonText("Create keyring")
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
		if (!this.password) { this.showError("Master password is required."); return; }
		if (this.password !== this.confirmPassword) { this.showError("Passwords do not match."); return; }

		this.isSubmitting = true;
		this.submitBtn.setDisabled(true);
		try {
			await this.plugin.keyringService.createKeyring(
				this.plugin.settings.masterKeyringPath,
				this.password,
			);
			this.plugin.patchSettings((s: VaultCryptSettings) => { s.keyringEnabled = true; });
			new Notice("Keyring created successfully.");
			this.close();
			this.onDone();
		} catch (e) {
			this.showError(`Error creating keyring: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.isSubmitting = false;
			this.submitBtn.setDisabled(false);
		}
	}

	onClose() { this.contentEl.empty(); }
}

export class KeyringUnlockModal extends Modal {
	private plugin: VaultCryptPlugin;
	private password = "";
	private errorEl!: HTMLParagraphElement;
	private isSubmitting = false;
	private submitBtn!: ButtonComponent;
	private onDone: (() => void) | undefined;

	constructor(app: App, plugin: VaultCryptPlugin, onDone?: () => void) {
		super(app);
		this.plugin = plugin;
		this.onDone = onDone;
	}

	onOpen() {
		const {contentEl} = this;
		this.titleEl.setText("Unlock with keyring");

		const managedLockedCount = peek(this.plugin.vaultCryptState$).profiles
			.filter(p => p.managedByKeyring && p.isLocked).length;

		contentEl.createEl("p", {
			text: `Enter your keyring master password to unlock ${managedLockedCount} profile${managedLockedCount !== 1 ? 's' : ''}.`,
		});

		new Setting(contentEl)
			.setName("Master password")
			.addText(text => {
				text.inputEl.type = "password";
				text.inputEl.focus();
				text.setPlaceholder("Enter keyring master password")
					.onChange(value => { this.password = value; });
				text.inputEl.addEventListener("keydown", (evt: KeyboardEvent) => {
					if (evt.key === "Enter") void this.submit();
				});
			});

		this.errorEl = contentEl.createEl("p", {cls: "mod-warning"});
		this.errorEl.addClass("vaultcrypt-hidden");

		new Setting(contentEl)
			.addButton(btn => btn.setButtonText("Cancel").onClick(() => this.close()))
			.addButton(btn => {
				this.submitBtn = btn;
				btn.setButtonText("Unlock all")
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
		if (!this.password) { this.showError("Master password is required."); return; }

		this.isSubmitting = true;
		this.submitBtn.setDisabled(true);
		try {
			const settings = this.plugin.settings;
			const managedIds = Object.entries(settings.profiles)
				.filter(([, cfg]) => cfg.managedByKeyring)
				.filter(([id]) => !this.plugin.sessionService.isUnlocked(id))
				.map(([id]) => id);

			const passwords = await this.plugin.keyringService.getProfilePasswords(
				settings.masterKeyringPath,
				this.password,
				managedIds,
			);

			const failures: string[] = [];
			for (const [profileId, profilePassword] of passwords) {
				const config = settings.profiles[profileId];
				if (!config) continue;
				try {
					await this.plugin.sessionService.unlockProfile(profileId, config, profilePassword);
				} catch {
					failures.push(profileId);
				}
			}

			if (failures.length > 0) {
				new Notice(`Failed to unlock: ${failures.join(', ')}. Stored passwords may be out of date.`);
			}

			const unlocked = passwords.size - failures.length;
			if (unlocked > 0) {
				new Notice(`Unlocked ${unlocked} profile${unlocked !== 1 ? 's' : ''} via keyring.`);
			}

			this.close();
			this.onDone?.();
		} catch (e) {
			console.error(e);
			this.showError("Incorrect master password or corrupted keyring.");
		} finally {
			this.isSubmitting = false;
			this.submitBtn.setDisabled(false);
		}
	}

	onClose() { this.contentEl.empty(); }
}

export class AddToKeyringModal extends Modal {
	private plugin: VaultCryptPlugin;
	private onDone: () => void;
	private selectedProfileId = "";
	private profilePassword = "";
	private keyringPassword = "";
	private errorEl!: HTMLParagraphElement;
	private isSubmitting = false;
	private submitBtn!: ButtonComponent;

	constructor(app: App, plugin: VaultCryptPlugin, onDone: () => void) {
		super(app);
		this.plugin = plugin;
		this.onDone = onDone;
	}

	onOpen() {
		const {contentEl} = this;
		this.titleEl.setText("Add profile to keyring");

		const profiles = this.plugin.settings.profiles;
		const unmanagedIds = Object.entries(profiles)
			.filter(([, cfg]) => !cfg.managedByKeyring)
			.map(([id]) => id);

		if (unmanagedIds.length === 0) {
			contentEl.createEl("p", {text: "All profiles are already managed by the keyring."});
			new Setting(contentEl)
				.addButton(btn => btn.setButtonText("Close").onClick(() => this.close()));
			return;
		}

		this.selectedProfileId = unmanagedIds[0] ?? "";

		new Setting(contentEl)
			.setName("Profile")
			.addDropdown(dd => {
				for (const id of unmanagedIds) {
					dd.addOption(id, id);
				}
				dd.setValue(this.selectedProfileId)
					.onChange(value => { this.selectedProfileId = value; });
			});

		new Setting(contentEl)
			.setName("Profile password")
			.setDesc("The current password for this profile (will be verified)")
			.addText(text => {
				text.inputEl.type = "password";
				text.setPlaceholder("Enter profile password")
					.onChange(value => { this.profilePassword = value; });
			});

		new Setting(contentEl)
			.setName("Keyring master password")
			.addText(text => {
				text.inputEl.type = "password";
				text.setPlaceholder("Enter keyring password")
					.onChange(value => { this.keyringPassword = value; });
				text.inputEl.addEventListener("keydown", (evt: KeyboardEvent) => {
					if (evt.key === "Enter") void this.submit();
				});
			});

		this.errorEl = contentEl.createEl("p", {cls: "mod-warning"});
		this.errorEl.addClass("vaultcrypt-hidden");

		new Setting(contentEl)
			.addButton(btn => btn.setButtonText("Cancel").onClick(() => this.close()))
			.addButton(btn => {
				this.submitBtn = btn;
				btn.setButtonText("Add to keyring")
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
		if (!this.selectedProfileId) { this.showError("No profile selected."); return; }
		if (!this.profilePassword) { this.showError("Profile password is required."); return; }
		if (!this.keyringPassword) { this.showError("Keyring master password is required."); return; }

		const config = this.plugin.settings.profiles[this.selectedProfileId];
		if (!config) { this.showError("Profile not found."); return; }

		this.isSubmitting = true;
		this.submitBtn.setDisabled(true);
		try {
			// Verify the profile password by trying to unlock (then lock if it wasn't already open)
			const wasUnlocked = this.plugin.sessionService.isUnlocked(this.selectedProfileId);
			try {
				await this.plugin.sessionService.unlockProfile(this.selectedProfileId, config, this.profilePassword);
			} catch {
				this.showError("Incorrect profile password.");
				return;
			}
			if (!wasUnlocked) {
				this.plugin.sessionService.lockProfile(this.selectedProfileId);
			}

			// Store in keyring
			await this.plugin.keyringService.setProfilePassword(
				this.plugin.settings.masterKeyringPath,
				this.keyringPassword,
				this.selectedProfileId,
				this.profilePassword,
			);

			// Mark as managed
			this.plugin.patchSettings((s: VaultCryptSettings) => {
				const profile = s.profiles[this.selectedProfileId];
				if (profile) profile.managedByKeyring = true;
			});

			new Notice(`Profile "${this.selectedProfileId}" added to keyring.`);
			this.close();
			this.onDone();
		} catch (e) {
			this.showError(`Error: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.isSubmitting = false;
			this.submitBtn.setDisabled(false);
		}
	}

	onClose() { this.contentEl.empty(); }
}

export class RemoveFromKeyringModal extends Modal {
	private plugin: VaultCryptPlugin;
	private profileId: string;
	private onDone: () => void;
	private keyringPassword = "";
	private errorEl!: HTMLParagraphElement;
	private isSubmitting = false;
	private submitBtn!: ButtonComponent;

	constructor(app: App, plugin: VaultCryptPlugin, profileId: string, onDone: () => void) {
		super(app);
		this.plugin = plugin;
		this.profileId = profileId;
		this.onDone = onDone;
	}

	onOpen() {
		const {contentEl} = this;
		this.titleEl.setText("Remove from keyring");

		contentEl.createEl("p", {
			text: `Remove "${this.profileId}" from the keyring? You will need to enter its password individually to unlock it.`,
		});

		new Setting(contentEl)
			.setName("Keyring master password")
			.addText(text => {
				text.inputEl.type = "password";
				text.inputEl.focus();
				text.setPlaceholder("Enter keyring password")
					.onChange(value => { this.keyringPassword = value; });
				text.inputEl.addEventListener("keydown", (evt: KeyboardEvent) => {
					if (evt.key === "Enter") void this.submit();
				});
			});

		this.errorEl = contentEl.createEl("p", {cls: "mod-warning"});
		this.errorEl.addClass("vaultcrypt-hidden");

		new Setting(contentEl)
			.addButton(btn => btn.setButtonText("Cancel").onClick(() => this.close()))
			.addButton(btn => {
				this.submitBtn = btn;
				btn.setButtonText("Remove")
					.setWarning()
					.onClick(() => this.submit());
			});
	}

	private showError(msg: string) {
		this.errorEl.textContent = msg;
		this.errorEl.removeClass("vaultcrypt-hidden");
	}

	private async submit() {
		if (this.isSubmitting) return;
		if (!this.keyringPassword) { this.showError("Keyring master password is required."); return; }

		this.isSubmitting = true;
		this.submitBtn.setDisabled(true);
		try {
			await this.plugin.keyringService.removeProfilePassword(
				this.plugin.settings.masterKeyringPath,
				this.keyringPassword,
				this.profileId,
			);
			this.plugin.patchSettings((s: VaultCryptSettings) => {
				const profile = s.profiles[this.profileId];
				if (profile) profile.managedByKeyring = false;
			});
			new Notice(`Profile "${this.profileId}" removed from keyring.`);
			this.close();
			this.onDone();
		} catch (e) {
			this.showError(`Error: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.isSubmitting = false;
			this.submitBtn.setDisabled(false);
		}
	}

	onClose() { this.contentEl.empty(); }
}

export class ChangeKeyringPasswordModal extends Modal {
	private plugin: VaultCryptPlugin;
	private onDone: () => void;
	private currentPassword = "";
	private newPassword = "";
	private confirmPassword = "";
	private errorEl!: HTMLParagraphElement;
	private isSubmitting = false;
	private submitBtn!: ButtonComponent;

	constructor(app: App, plugin: VaultCryptPlugin, onDone: () => void) {
		super(app);
		this.plugin = plugin;
		this.onDone = onDone;
	}

	onOpen() {
		const {contentEl} = this;
		this.titleEl.setText("Change keyring password");

		new Setting(contentEl)
			.setName("Current password")
			.addText(text => {
				text.inputEl.type = "password";
				text.inputEl.focus();
				text.setPlaceholder("Enter current password")
					.onChange(value => { this.currentPassword = value; });
			});

		new Setting(contentEl)
			.setName("New password")
			.addText(text => {
				text.inputEl.type = "password";
				text.setPlaceholder("Enter new password")
					.onChange(value => { this.newPassword = value; });
			});

		new Setting(contentEl)
			.setName("Confirm new password")
			.addText(text => {
				text.inputEl.type = "password";
				text.setPlaceholder("Confirm new password")
					.onChange(value => { this.confirmPassword = value; });
				text.inputEl.addEventListener("keydown", (evt: KeyboardEvent) => {
					if (evt.key === "Enter") void this.submit();
				});
			});

		this.errorEl = contentEl.createEl("p", {cls: "mod-warning"});
		this.errorEl.addClass("vaultcrypt-hidden");

		new Setting(contentEl)
			.addButton(btn => btn.setButtonText("Cancel").onClick(() => this.close()))
			.addButton(btn => {
				this.submitBtn = btn;
				btn.setButtonText("Change password")
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
		if (!this.currentPassword) { this.showError("Current password is required."); return; }
		if (!this.newPassword) { this.showError("New password is required."); return; }
		if (this.newPassword !== this.confirmPassword) { this.showError("Passwords do not match."); return; }

		this.isSubmitting = true;
		this.submitBtn.setDisabled(true);
		try {
			await this.plugin.keyringService.changeMasterPassword(
				this.plugin.settings.masterKeyringPath,
				this.currentPassword,
				this.newPassword,
			);
			new Notice("Keyring password changed successfully.");
			this.close();
			this.onDone();
		} catch (e) {
			this.showError(`Error: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.isSubmitting = false;
			this.submitBtn.setDisabled(false);
		}
	}

	onClose() { this.contentEl.empty(); }
}

export class DeleteKeyringModal extends Modal {
	private plugin: VaultCryptPlugin;
	private onDone: () => void;
	private password = "";
	private errorEl!: HTMLParagraphElement;
	private isSubmitting = false;
	private submitBtn!: ButtonComponent;

	constructor(app: App, plugin: VaultCryptPlugin, onDone: () => void) {
		super(app);
		this.plugin = plugin;
		this.onDone = onDone;
	}

	onOpen() {
		const {contentEl} = this;
		this.titleEl.setText("Delete keyring");

		contentEl.createEl("p", {
			text: "This will delete the keyring and remove all profile associations. " +
				"You will need to enter each profile's password individually to unlock them. " +
				"Profile passwords are NOT lost — they remain in each profile's own database.",
		});

		new Setting(contentEl)
			.setName("Keyring master password")
			.setDesc("Enter your keyring password to confirm deletion")
			.addText(text => {
				text.inputEl.type = "password";
				text.inputEl.focus();
				text.setPlaceholder("Enter keyring password")
					.onChange(value => { this.password = value; });
				text.inputEl.addEventListener("keydown", (evt: KeyboardEvent) => {
					if (evt.key === "Enter") void this.submit();
				});
			});

		this.errorEl = contentEl.createEl("p", {cls: "mod-warning"});
		this.errorEl.addClass("vaultcrypt-hidden");

		new Setting(contentEl)
			.addButton(btn => btn.setButtonText("Cancel").onClick(() => this.close()))
			.addButton(btn => {
				this.submitBtn = btn;
				btn.setButtonText("Delete keyring")
					.setWarning()
					.onClick(() => this.submit());
			});
	}

	private showError(msg: string) {
		this.errorEl.textContent = msg;
		this.errorEl.removeClass("vaultcrypt-hidden");
	}

	private async submit() {
		if (this.isSubmitting) return;
		if (!this.password) { this.showError("Password is required to confirm deletion."); return; }

		this.isSubmitting = true;
		this.submitBtn.setDisabled(true);
		try {
			// Verify password by listing entries (will throw on wrong password)
			await this.plugin.keyringService.listManagedProfileIds(
				this.plugin.settings.masterKeyringPath,
				this.password,
			);

			// Delete the file
			await this.plugin.keyringService.deleteKeyring(this.plugin.settings.masterKeyringPath);

			// Reset settings
			this.plugin.patchSettings((s: VaultCryptSettings) => {
				s.keyringEnabled = false;
				for (const config of Object.values(s.profiles)) {
					config.managedByKeyring = false;
				}
			});

			new Notice("Keyring deleted.");
			this.close();
			this.onDone();
		} catch (e) {
			this.showError(`Error: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.isSubmitting = false;
			this.submitBtn.setDisabled(false);
		}
	}

	onClose() { this.contentEl.empty(); }
}
