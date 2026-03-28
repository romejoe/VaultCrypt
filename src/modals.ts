import {App, ButtonComponent, DropdownComponent, Editor, Modal, Notice, Setting, TextComponent} from "obsidian";
import VaultCryptPlugin, {VaultCryptState} from "./main";
import {ProfileConfig, validateProfileName, VaultCryptSettings} from "./settings";
import {KdbxVersion} from "./kdbx-service";
import {DbTreeNode} from "./unlock-session";
import {effect, peek, StopEffect} from "@maverick-js/signals";

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

			await this.plugin.addProfile(this.name, this.password, this.version);

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
			// Remove from keyring before deleting the profile; fail closed so a
			// wrong password or write error doesn't leave an orphaned keyring entry
			if (this.config.managedByKeyring) {
				await this.plugin.keyringService.removeProfilePassword(
					this.plugin.settings.masterKeyringPath,
					this.keyringPassword,
					this.profileName.toLowerCase(),
				);
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
		contentEl.createEl("p", {
			text: "⚠ Security tradeoff: if the keyring file or its master password " +
				"is compromised, every managed profile password is exposed at once.",
			cls: "mod-warning",
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
					if (evt.key === "Enter") void this.submit();
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
		if (!this.password) {
			this.showError("Master password is required.");
			return;
		}
		if (this.password !== this.confirmPassword) {
			this.showError("Passwords do not match.");
			return;
		}

		this.isSubmitting = true;
		this.submitBtn.setDisabled(true);
		try {
			await this.plugin.keyringService.createKeyring(
				this.plugin.settings.masterKeyringPath,
				this.password,
			);
			this.plugin.patchSettings((s: VaultCryptSettings) => {
				s.keyringEnabled = true;
			});
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

	onClose() {
		this.contentEl.empty();
	}
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
					.onChange(value => {
						this.password = value;
					});
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
		if (!this.password) {
			this.showError("Master password is required.");
			return;
		}

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

	onClose() {
		this.contentEl.empty();
	}
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

		contentEl.createEl("p", {
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			text: "⚠ Security tradeoff: adding a profile to the keyring means a compromised keyring or master password exposes this profile password alongside all others.",
			cls: "mod-warning",
		});

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
					.onChange(value => {
						this.selectedProfileId = value;
					});
			});

		new Setting(contentEl)
			.setName("Profile password")
			.setDesc("The current password for this profile (will be verified)")
			.addText(text => {
				text.inputEl.type = "password";
				text.setPlaceholder("Enter profile password")
					.onChange(value => {
						this.profilePassword = value;
					});
			});

		new Setting(contentEl)
			.setName("Keyring master password")
			.addText(text => {
				text.inputEl.type = "password";
				text.setPlaceholder("Enter keyring password")
					.onChange(value => {
						this.keyringPassword = value;
					});
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
		if (!this.selectedProfileId) {
			this.showError("No profile selected.");
			return;
		}
		if (!this.profilePassword) {
			this.showError("Profile password is required.");
			return;
		}
		if (!this.keyringPassword) {
			this.showError("Keyring master password is required.");
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
			// Verify the profile password without mutating session state
			const passwordCorrect = await this.plugin.sessionService.checkProfilePassword(config, this.profilePassword);
			if (!passwordCorrect) {
				this.showError("Incorrect profile password.");
				return;
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

			this.plugin.mutateState((s: VaultCryptState) => {
				const profile = s.profiles.find(profile => profile.id === this.selectedProfileId);
				if (profile) profile.managedByKeyring = true;
			});

			new Notice(`Profile "${this.selectedProfileId}" added to keyring.`);
			this.close();
			this.onDone();
		} catch (e) {
			this.showError(e instanceof Error ? e.message : `Error: ${String(e)}`);
		} finally {
			this.isSubmitting = false;
			this.submitBtn.setDisabled(false);
		}
	}

	onClose() {
		this.contentEl.empty();
	}
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
					.onChange(value => {
						this.keyringPassword = value;
					});
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
		if (!this.keyringPassword) {
			this.showError("Keyring master password is required.");
			return;
		}

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

			this.plugin.mutateState((s: VaultCryptState) => {
				const profile = s.profiles.find(profile => profile.id === this.profileId);
				if (profile) profile.managedByKeyring = false;
			})

			new Notice(`Profile "${this.profileId}" removed from keyring.`);
			this.close();
			this.onDone();
		} catch (e) {
			this.showError(e instanceof Error ? e.message : `Error: ${String(e)}`);
		} finally {
			this.isSubmitting = false;
			this.submitBtn.setDisabled(false);
		}
	}

	onClose() {
		this.contentEl.empty();
	}
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
					.onChange(value => {
						this.currentPassword = value;
					});
			});

		new Setting(contentEl)
			.setName("New password")
			.addText(text => {
				text.inputEl.type = "password";
				text.setPlaceholder("Enter new password")
					.onChange(value => {
						this.newPassword = value;
					});
			});

		new Setting(contentEl)
			.setName("Confirm new password")
			.addText(text => {
				text.inputEl.type = "password";
				text.setPlaceholder("Confirm new password")
					.onChange(value => {
						this.confirmPassword = value;
					});
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
		if (!this.currentPassword) {
			this.showError("Current password is required.");
			return;
		}
		if (!this.newPassword) {
			this.showError("New password is required.");
			return;
		}
		if (this.newPassword !== this.confirmPassword) {
			this.showError("Passwords do not match.");
			return;
		}

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
			this.showError(e instanceof Error ? e.message : `Error: ${String(e)}`);
		} finally {
			this.isSubmitting = false;
			this.submitBtn.setDisabled(false);
		}
	}

	onClose() {
		this.contentEl.empty();
	}
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
					.onChange(value => {
						this.password = value;
					});
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
		if (!this.password) {
			this.showError("Password is required to confirm deletion.");
			return;
		}

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

			this.plugin.mutateState((s: VaultCryptState) => {
				s.profiles.forEach(profile => profile.managedByKeyring = false);
			})

			new Notice("Keyring deleted.");
			this.close();
			this.onDone();
		} catch (e) {
			this.showError(e instanceof Error ? e.message : `Error: ${String(e)}`);
		} finally {
			this.isSubmitting = false;
			this.submitBtn.setDisabled(false);
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function generatePassword(
	length = 20,
	opts: { upper: boolean; lower: boolean; digits: boolean; symbols: boolean } = {
		upper: true, lower: true, digits: true, symbols: true,
	},
): string {
	let charset = '';
	if (opts.upper) charset += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
	if (opts.lower) charset += 'abcdefghijklmnopqrstuvwxyz';
	if (opts.digits) charset += '0123456789';
	if (opts.symbols) charset += '!@#$%^&*()-_=+[]{}|;:,.<>?';
	if (!charset) charset = 'abcdefghijklmnopqrstuvwxyz';

	const result: string[] = [];
	const max = Math.floor(0xffffffff / charset.length) * charset.length;
	while (result.length < length) {
		const buf = new Uint32Array(length * 2);
		crypto.getRandomValues(buf);
		for (const val of buf) {
			if (result.length >= length) break;
			if (val < max) result.push(charset[val % charset.length]!);
		}
	}
	return result.join('');
}

// ── Generate Password Modal ───────────────────────────────────────────────────

class GeneratePasswordModal extends Modal {
	private onApply: (pw: string) => void;
	private length = 20;
	private opts = {upper: true, lower: true, digits: true, symbols: true};
	private currentPassword: string;
	private previewEl!: HTMLElement;

	constructor(app: App, onApply: (pw: string) => void) {
		super(app);
		this.onApply = onApply;
		this.currentPassword = generatePassword(this.length, this.opts);
	}

	onOpen() {
		const {contentEl} = this;
		this.titleEl.setText('Generate password');

		new Setting(contentEl)
			.setName('Length')
			.addSlider(slider => slider
				.setLimits(8, 64, 1)
				.setValue(this.length)
				.setDynamicTooltip()
				.onChange(v => {
					this.length = v;
					this.refreshPreview();
				}));

		new Setting(contentEl)
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setName('Uppercase letters (A–Z)')
			.addToggle(t => t.setValue(this.opts.upper).onChange(v => {
				this.opts.upper = v;
				this.refreshPreview();
			}));

		new Setting(contentEl)
			.setName('Lowercase letters (a–z)')
			.addToggle(t => t.setValue(this.opts.lower).onChange(v => {
				this.opts.lower = v;
				this.refreshPreview();
			}));

		new Setting(contentEl)
			.setName('Digits (0–9)')
			.addToggle(t => t.setValue(this.opts.digits).onChange(v => {
				this.opts.digits = v;
				this.refreshPreview();
			}));

		new Setting(contentEl)
			.setName('Symbols')
			.addToggle(t => t.setValue(this.opts.symbols).onChange(v => {
				this.opts.symbols = v;
				this.refreshPreview();
			}));

		const previewSetting = new Setting(contentEl).setName('Preview');
		this.previewEl = previewSetting.controlEl.createEl('code', {
			text: this.currentPassword,
			cls: 'vaultcrypt-password-preview',
		});
		previewSetting.addButton(btn => btn
			.setIcon('refresh-cw')
			.setTooltip('Regenerate')
			.onClick(() => this.refreshPreview()));

		new Setting(contentEl)
			.addButton(btn => btn.setButtonText('Cancel').onClick(() => this.close()))
			.addButton(btn => btn
				.setButtonText('Apply')
				.setCta()
				.onClick(() => {
					this.onApply(this.currentPassword);
					this.close();
				}));
	}

	private refreshPreview() {
		this.currentPassword = generatePassword(this.length, this.opts);
		this.previewEl?.setText(this.currentPassword);
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ── Insert Secret Modal ───────────────────────────────────────────────────────

export class InsertSecretModal extends Modal {
	private plugin: VaultCryptPlugin;
	private editor?: Editor;

	// Selection state
	private selectedProfileId: string;
	private selectedEntryPath: string | null = null;
	private newEntryGroupPath: string | null = null;

	// New-entry form values
	private entryName = '';
	private fieldUserName = '';
	private fieldPassword = '';
	private fieldURL = '';
	private customFields: { key: string; value: string }[] = [];

	// Reference field choice
	private referenceField = '';

	// DOM refs
	private lockedWarningEl!: HTMLElement;
	private treeContainerEl!: HTMLElement;
	private entryFieldsSectionEl!: HTMLElement;
	private customFieldsContainerEl!: HTMLElement;
	private fieldRefDropdown?: DropdownComponent;
	private tokenPreviewEl!: HTMLElement;
	private errorEl!: HTMLParagraphElement;
	private insertBtn!: ButtonComponent;
	private passwordTextComponent?: TextComponent;
	private isSubmitting = false;
	private isOpen = false;
	private stopLockEffect?: StopEffect;
	private virtualGroupPaths = new Set<string>();
	private expandedPaths = new Set<string>();
	private entryNameErrorEl!: HTMLElement;

	constructor(app: App, plugin: VaultCryptPlugin, editor?: Editor) {
		super(app);
		this.plugin = plugin;
		this.editor = editor;

		const settings = plugin.settings;
		const profileIds = Object.keys(settings.profiles);
		this.selectedProfileId =
			(plugin.lastUsedProfileId && settings.profiles[plugin.lastUsedProfileId])
				? plugin.lastUsedProfileId
				: settings.general.defaultProfile && settings.profiles[settings.general.defaultProfile]
					? settings.general.defaultProfile
					: profileIds[0] ?? '';
	}

	onOpen() {
		this.isOpen = true;
		const {contentEl} = this;
		this.titleEl.setText('Insert secret');

		this.startLockStateEffect();

		const profileIds = Object.keys(this.plugin.settings.profiles);
		if (profileIds.length === 0) {
			contentEl.createEl('p', {text: 'No profiles configured. Create a profile first.'});
			new Setting(contentEl).addButton(btn => btn.setButtonText('Close').setCta().onClick(() => this.close()));
			return;
		}

		// Profile dropdown
		new Setting(contentEl)
			.setName('Profile')
			.addDropdown(dd => {
				for (const id of profileIds) dd.addOption(id, id);
				dd.setValue(this.selectedProfileId).onChange(value => {
					this.selectedProfileId = value;
					this.selectedEntryPath = null;
					this.newEntryGroupPath = null;
					this.virtualGroupPaths.clear();
					this.expandedPaths.clear();
					this.referenceField = '';
					this.startLockStateEffect();
					this.onProfileChanged();
				});
			});

		// Locked warning + unlock button
		const lockedDiv = contentEl.createDiv({cls: 'vaultcrypt-insert-locked vaultcrypt-hidden'});
		lockedDiv.createEl('p', {cls: 'mod-warning', text: 'This profile is locked.'});
		new ButtonComponent(lockedDiv)
			.setButtonText('Unlock profile')
			.onClick(() => {
				new UnlockModal(this.app, this.plugin, this.selectedProfileId).open();
			});
		this.lockedWarningEl = lockedDiv;

		// Tree label + container
		contentEl.createEl('p', {cls: 'setting-item-name', text: 'Select group or entry'});
		this.treeContainerEl = contentEl.createDiv({cls: 'vaultcrypt-tree-container'});

		// Entry fields section (hidden until "New entry here" is clicked)
		this.entryFieldsSectionEl = contentEl.createDiv({cls: 'vaultcrypt-hidden'});
		this.buildEntryFieldsSection(this.entryFieldsSectionEl);

		// Field reference + token preview
		const fieldRefContainer = contentEl.createDiv();
		this.buildFieldRefSection(fieldRefContainer);

		// Error message
		this.errorEl = contentEl.createEl('p', {cls: 'mod-warning vaultcrypt-hidden'});

		// Cancel / Insert buttons
		new Setting(contentEl)
			.addButton(btn => btn.setButtonText('Cancel').onClick(() => this.close()))
			.addButton(btn => {
				this.insertBtn = btn;
				btn.setButtonText('Insert').setCta().setDisabled(true)
					.onClick(() => {
						this.submit().catch(e => console.error('[VaultCrypt] InsertSecretModal error', e));
					});
			});

		this.onProfileChanged();
	}

	private onProfileChanged() {
		const locked = !this.plugin.sessionService.isUnlocked(this.selectedProfileId);
		if (locked) {
			this.lockedWarningEl.removeClass('vaultcrypt-hidden');
		} else {
			this.lockedWarningEl.addClass('vaultcrypt-hidden');
		}
		this.selectedEntryPath = null;
		this.newEntryGroupPath = null;
		this.virtualGroupPaths.clear();
		this.expandedPaths.clear();
		this.entryFieldsSectionEl.addClass('vaultcrypt-hidden');
		this.renderTree();
		this.refreshFieldDropdown();
		this.updateInsertButtonState();
	}

	/**
	 * Creates/replaces the reactive effect that watches `vaultCryptState$` for lock-state
	 * changes on the currently-selected profile. Scoped to `selectedProfileId` at call
	 * time — call again whenever the profile changes to re-scope. The previous effect is
	 * stopped (no memory leak) before the new one is registered.
	 */
	private startLockStateEffect() {
		this.stopLockEffect?.();
		const profileId = this.selectedProfileId;
		// Capture the current locked state so the first (synchronous) effect run is a
		// no-op; `onProfileChanged` / the initial render already handles initial state.
		const initialState = peek(this.plugin.vaultCryptState$);
		let prevLocked = initialState.profiles.find(p => p.id === profileId)?.isLocked ?? true;
		this.stopLockEffect = effect(() => {
			const state = this.plugin.vaultCryptState$();
			const locked = state.profiles.find(p => p.id === profileId)?.isLocked ?? true;
			if (locked === prevLocked) return;
			prevLocked = locked;
			if (this.isOpen) this.onLockStateChanged(locked);
		});
	}

	/** Called when the current profile's lock state changes without a profile switch. */
	private onLockStateChanged(locked: boolean) {
		if (locked) {
			this.lockedWarningEl.removeClass('vaultcrypt-hidden');
			this.selectedEntryPath = null;
			this.newEntryGroupPath = null;
			this.virtualGroupPaths.clear();
			this.entryFieldsSectionEl.addClass('vaultcrypt-hidden');
		} else {
			this.lockedWarningEl.addClass('vaultcrypt-hidden');
		}
		this.renderTree();
		this.refreshFieldDropdown();
		this.updateInsertButtonState();
	}

	private renderTree() {
		this.treeContainerEl.empty();
		const locked = !this.plugin.sessionService.isUnlocked(this.selectedProfileId);
		if (locked) {
			this.treeContainerEl.createEl('p', {
				cls: 'setting-item-description',
				text: 'Unlock the profile to browse the database.',
			});
			return;
		}
		const rawTree = this.plugin.sessionService.getEntryTree(this.selectedProfileId);
		if (!rawTree) return;
		const tree = this.augmentTreeWithVirtualGroups(rawTree);
		const ul = this.buildGroupUl(tree);
		ul.addClass('vaultcrypt-tree-root');
		this.treeContainerEl.appendChild(ul);
	}

	private augmentTreeWithVirtualGroups(root: DbTreeNode): DbTreeNode {
		if (this.virtualGroupPaths.size === 0) return root;
		const cloneNode = (node: DbTreeNode): DbTreeNode => ({
			name: node.name,
			path: node.path,
			groups: node.groups.map(cloneNode),
			entries: [...node.entries],
		});
		const cloned = cloneNode(root);
		for (const vPath of this.virtualGroupPaths) {
			const segments = vPath.split('/');
			let current = cloned;
			for (let i = 0; i < segments.length; i++) {
				const seg = segments[i]!;
				const segPath = segments.slice(0, i + 1).join('/');
				let child = current.groups.find(g => g.path === segPath);
				if (!child) {
					child = {name: seg, path: segPath, groups: [], entries: []};
					current.groups.push(child);
				}
				current = child;
			}
		}
		return cloned;
	}

	private buildGroupUl(node: DbTreeNode): HTMLUListElement {
		const ul = document.createElement('ul');
		ul.addClass('vaultcrypt-tree-ul');

		for (const childGroup of node.groups) {
			const li = ul.createEl('li');
			const isExpanded = this.expandedPaths.has(childGroup.path);
			const caretCls = 'vaultcrypt-tree-caret' + (isExpanded ? ' vaultcrypt-tree-caret-open' : '');
			const caret = li.createEl('span', {cls: caretCls, text: childGroup.name || '(unnamed)'});
			const nestedCls = 'vaultcrypt-tree-ul vaultcrypt-tree-nested' + (isExpanded ? ' vaultcrypt-tree-active' : '');
			const nested = li.createEl('ul', {cls: nestedCls});

			const childUl = this.buildGroupUl(childGroup);
			for (const child of Array.from(childUl.children)) {
				nested.appendChild(child);
			}

			caret.addEventListener('click', (e) => {
				e.stopPropagation();
				const nowOpen = caret.classList.toggle('vaultcrypt-tree-caret-open');
				nested.classList.toggle('vaultcrypt-tree-active', nowOpen);
				if (nowOpen) this.expandedPaths.add(childGroup.path);
				else this.expandedPaths.delete(childGroup.path);
			});
			li.appendChild(nested);
		}

		for (const entry of node.entries) {
			const li = ul.createEl('li', {cls: 'vaultcrypt-tree-entry', text: entry.name || '(untitled)'});
			li.addEventListener('click', () => this.selectEntry(entry.path, li));
		}

		const newEntryLi = ul.createEl('li', {cls: 'vaultcrypt-tree-new-entry', text: 'New entry here'});
		newEntryLi.addEventListener('click', () => this.selectNewEntry(node.path, newEntryLi));

		const newGroupLi = ul.createEl('li', {cls: 'vaultcrypt-tree-new-entry', text: 'New group here'});
		newGroupLi.addEventListener('click', (e) => {
			e.stopPropagation();
			this.startInlineGroupCreate(newGroupLi, node.path);
		});

		return ul;
	}

	private startInlineGroupCreate(li: HTMLElement, parentPath: string) {
		li.empty();
		const input = li.createEl('input', {cls: 'vaultcrypt-tree-group-input'});
		input.type = 'text';
		input.placeholder = 'Group name';
		input.focus();

		const restore = () => {
			li.empty();
			li.textContent = 'New group here';
		};
		const confirm = () => {
			const name = input.value.trim();
			if (name) this.addVirtualGroup(parentPath, name);
			else restore();
		};
		input.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter') { e.stopPropagation(); confirm(); }
			if (e.key === 'Escape') { e.stopPropagation(); restore(); }
		});
		// defer blur so Enter/Escape fire first
		input.addEventListener('blur', () => window.setTimeout(confirm, 100));
	}

	private addVirtualGroup(parentPath: string, name: string) {
		const fullPath = parentPath ? `${parentPath}/${name}` : name;
		this.virtualGroupPaths.add(fullPath);
		this.expandedPaths.add(fullPath);
		if (parentPath) this.expandedPaths.add(parentPath);
		this.renderTree();
	}

	private clearTreeSelections() {
		this.treeContainerEl.querySelectorAll<HTMLElement>('.is-active').forEach(el => el.removeClass('is-active'));
	}

	private selectEntry(entryPath: string, clickedEl: HTMLElement) {
		this.clearTreeSelections();
		clickedEl.addClass('is-active');
		this.selectedEntryPath = entryPath;
		this.newEntryGroupPath = null;
		this.entryFieldsSectionEl.addClass('vaultcrypt-hidden');
		this.refreshFieldDropdown();
		this.updateInsertButtonState();
	}

	private selectNewEntry(groupPath: string, clickedEl: HTMLElement) {
		this.clearTreeSelections();
		clickedEl.addClass('is-active');
		this.newEntryGroupPath = groupPath;
		this.selectedEntryPath = null;
		this.entryFieldsSectionEl.removeClass('vaultcrypt-hidden');
		this.refreshFieldDropdown();
		this.updateInsertButtonState();
	}

	private buildEntryFieldsSection(container: HTMLElement) {
		container.createEl('hr');

		new Setting(container)
			.setName('Entry name (required)')
			.setDesc('Becomes the entry title in the database')
			.addText(text => text
				.setPlaceholder('Enter entry name')
				.onChange(value => {
					this.entryName = value;
					const hasSlash = value.includes('/');
					if (hasSlash) {
						this.entryNameErrorEl.textContent = 'Entry name cannot contain "/"';
						this.entryNameErrorEl.removeClass('vaultcrypt-hidden');
					} else {
						this.entryNameErrorEl.addClass('vaultcrypt-hidden');
					}
					this.refreshFieldDropdown();
					this.updateTokenPreview();
					this.updateInsertButtonState();
				}));
		this.entryNameErrorEl = container.createEl('p', {cls: 'mod-warning vaultcrypt-hidden'});

		new Setting(container)
			.setName('Username')
			.addText(text => text
				.setPlaceholder('Optional')
				.onChange(value => {
					this.fieldUserName = value;
					this.refreshFieldDropdown();
				}));

		new Setting(container)
			.setName('Password')
			.addText(text => {
				text.inputEl.type = 'password';
				text.setPlaceholder('Optional')
					.onChange(value => {
						this.fieldPassword = value;
						this.refreshFieldDropdown();
					});
				this.passwordTextComponent = text;
			})
			.addButton(btn => btn
				.setIcon('eye')
				.setTooltip('Show password')
				.onClick(() => {
					if (this.passwordTextComponent?.inputEl.type === 'password') {
						this.passwordTextComponent.inputEl.type = 'text';
						btn.setIcon('eye-off').setTooltip('Hide password');
					} else if (this.passwordTextComponent) {
						this.passwordTextComponent.inputEl.type = 'password';
						btn.setIcon('eye').setTooltip('Show password');
					}
				}))
			.addButton(btn => btn
				.setButtonText('Generate')
				.onClick(() => {
					new GeneratePasswordModal(this.app, (pw: string) => {
						this.passwordTextComponent?.setValue(pw);
						this.fieldPassword = pw;
						this.refreshFieldDropdown();
					}).open();
				}));

		new Setting(container)
			.setName('URL')
			.addText(text => text
				.setPlaceholder('Optional')
				.onChange(value => {
					this.fieldURL = value;
					this.refreshFieldDropdown();
				}));

		this.customFieldsContainerEl = container.createDiv();

		new Setting(container)
			.addButton(btn => btn
				.setButtonText('Add custom field')
				.onClick(() => {
					this.customFields.push({key: '', value: ''});
					this.renderCustomFields();
					this.refreshFieldDropdown();
				}));
	}

	private renderCustomFields() {
		this.customFieldsContainerEl.empty();
		for (let i = 0; i < this.customFields.length; i++) {
			const field = this.customFields[i]!;
			new Setting(this.customFieldsContainerEl)
				.addText(text => text
					.setPlaceholder('Key')
					.setValue(field.key)
					.onChange(v => {
						field.key = v;
						this.refreshFieldDropdown();
						this.updateInsertButtonState();
					}))
				.addText(text => text
					.setPlaceholder('Value')
					.setValue(field.value)
					.onChange(v => {
						field.value = v;
					}))
				.addButton(btn => btn
					.setButtonText('×')
					.onClick(() => {
						this.customFields.splice(i, 1);
						this.renderCustomFields();
						this.refreshFieldDropdown();
					}));
		}
	}

	private buildFieldRefSection(container: HTMLElement) {
		new Setting(container)
			.setName('Reference field')
			.setDesc('The field whose value will be resolved when the chip is revealed')
			.addDropdown(dd => {
				this.fieldRefDropdown = dd;
				dd.onChange(value => {
					this.referenceField = value;
					this.updateTokenPreview();
				});
			});

		this.tokenPreviewEl = container.createDiv({cls: 'vaultcrypt-token-preview-row'});
	}

	private refreshFieldDropdown() {
		const dd = this.fieldRefDropdown;
		if (!dd) return;

		const options: string[] = [];

		if (this.selectedEntryPath) {
			const names = this.plugin.sessionService.getEntryFieldNames(
				this.selectedProfileId,
				this.selectedEntryPath,
			);
			if (names) {
				for (const name of names) {
					if (name !== 'Title') options.push(name);
				}
			}
		} else if (this.newEntryGroupPath !== null) {
			// Always offer Password for new entries even if blank
			options.push('Password');
			if (this.fieldUserName) options.push('UserName');
			if (this.fieldURL) options.push('URL');
			for (const cf of this.customFields) {
				if (cf.key && !options.includes(cf.key)) options.push(cf.key);
			}
		}

		// Rebuild the <select> options
		dd.selectEl.empty();
		if (options.length === 0) {
			dd.addOption('', '— select an entry first —');
			this.referenceField = '';
		} else {
			for (const opt of options) dd.addOption(opt, opt);
			const config = this.plugin.settings.profiles[this.selectedProfileId];
			const defaultField = config?.defaultField ?? 'Password';
			const preferred = options.includes(this.referenceField)
				? this.referenceField
				: options.includes(defaultField)
					? defaultField
					: options[0]!;
			dd.setValue(preferred);
			this.referenceField = preferred;
		}

		this.updateTokenPreview();
	}

	private updateTokenPreview() {
		if (!this.tokenPreviewEl) return;
		const token = this.buildTokenString();
		this.tokenPreviewEl.setText(token ?? '');
	}

	private buildTokenString(): string | null {
		const profileId = this.selectedProfileId;
		let entryPath: string | null = null;

		if (this.selectedEntryPath) {
			entryPath = this.selectedEntryPath;
		} else if (this.newEntryGroupPath !== null && this.entryName) {
			entryPath = this.newEntryGroupPath
				? `${this.newEntryGroupPath}/${this.entryName}`
				: this.entryName;
		}

		if (!profileId || !entryPath) return null;

		const config = this.plugin.settings.profiles[profileId];
		const defaultField = config?.defaultField ?? 'Password';
		const field = this.referenceField || defaultField;

		return field === defaultField
			? `{{vc:${profileId}/${entryPath}}}`
			: `{{vc:${profileId}/${entryPath}#${field}}}`;
	}

	private validateCustomFields(): string | null {
		const reserved = new Set(['Title', 'UserName', 'Password', 'URL', 'Notes']);
		const seen = new Set<string>();
		for (const cf of this.customFields) {
			if (!cf.key) return 'Custom field key cannot be empty';
			if (reserved.has(cf.key)) return `"${cf.key}" is a reserved field name`;
			if (seen.has(cf.key)) return `Duplicate custom field key: "${cf.key}"`;
			seen.add(cf.key);
		}
		return null;
	}

	private updateInsertButtonState() {
		const hasSelection = this.selectedEntryPath !== null || this.newEntryGroupPath !== null;
		const entryNameOk = this.newEntryGroupPath === null || (!!this.entryName && !this.entryName.includes('/'));
		const customFieldsOk = this.newEntryGroupPath === null || this.validateCustomFields() === null;
		this.insertBtn?.setDisabled(!hasSelection || !entryNameOk || !customFieldsOk);
	}

	private showError(msg: string) {
		this.errorEl.textContent = msg;
		this.errorEl.removeClass('vaultcrypt-hidden');
	}

	private async submit() {
		if (this.isSubmitting) return;
		this.isSubmitting = true;
		this.insertBtn.setDisabled(true);
		this.errorEl.addClass('vaultcrypt-hidden');

		try {
			const token = this.buildTokenString();
			if (!token) {
				this.showError('Select a group or entry first.');
				return;
			}

			if (this.newEntryGroupPath !== null) {
				if (!this.entryName) {
					this.showError('Entry name is required.');
					return;
				}
				if (this.entryName.includes('/')) {
					this.showError('Entry name cannot contain "/".');
					return;
				}
				const cfError = this.validateCustomFields();
				if (cfError) {
					this.showError(cfError);
					return;
				}
				const entryPath = this.newEntryGroupPath
					? `${this.newEntryGroupPath}/${this.entryName}`
					: this.entryName;
				const config = this.plugin.settings.profiles[this.selectedProfileId];
				if (!config) {
					this.showError('Profile not found.');
					return;
				}

				const fields: Record<string, string> = {};
				if (this.fieldUserName) fields['UserName'] = this.fieldUserName;
				if (this.fieldPassword) fields['Password'] = this.fieldPassword;
				if (this.fieldURL) fields['URL'] = this.fieldURL;
				for (const cf of this.customFields) {
					if (cf.key && cf.value) fields[cf.key] = cf.value;
				}

				await this.plugin.sessionService.createEntryWithFields(
					this.selectedProfileId,
					entryPath,
					fields,
					config.path,
				);
			}

			this.editor?.replaceRange(token, this.editor.getCursor());
			this.plugin.lastUsedProfileId = this.selectedProfileId;
			new Notice('Secret inserted');
			this.close();
		} catch (e) {
			console.error('[VaultCrypt] InsertSecretModal submit error', e);
			this.showError(`Error: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.isSubmitting = false;
			this.insertBtn.setDisabled(false);
		}
	}

	onClose() {
		this.isOpen = false;
		this.stopLockEffect?.();
		this.contentEl.empty();
	}
}
