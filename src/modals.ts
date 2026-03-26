import {App, ButtonComponent, Modal, Setting} from "obsidian";
import VaultCryptPlugin from "./main";
import {ProfileConfig, validateProfileName} from "./settings";
import {KdbxVersion} from "./kdbx-service";

export class UnlockModal extends Modal {
	private plugin: VaultCryptPlugin;
	private selectedProfileId: string;
	private password = "";
	private errorEl: HTMLParagraphElement;
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
	private errorEl: HTMLParagraphElement;
	private isSubmitting = false;
	private submitBtn!: ButtonComponent;

	constructor(app: App, plugin: VaultCryptPlugin, onDone: () => void) {
		super(app);
		this.plugin = plugin;
		this.onDone = onDone;
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

		this.isSubmitting = true;
		this.submitBtn.setDisabled(true);
		try {
			await this.plugin.addProfile(this.name, this.password, this.version);
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
	private errorEl: HTMLParagraphElement;
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
	private errorEl: HTMLParagraphElement;
	private isSubmitting = false;
	private submitBtn!: ButtonComponent;

	constructor(app: App, currentName: string, plugin: VaultCryptPlugin, onDone: () => void) {
		super(app);
		this.currentName = currentName;
		this.newName = currentName;
		this.plugin = plugin;
		this.onDone = onDone;
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

	private async submit() {
		if (this.isSubmitting) return;

		// Synchronous validation — exclude current name so a no-op rename isn't blocked
		const existingNames = Object.keys(this.plugin.settings.profiles)
			.filter(n => n.toLowerCase() !== this.currentName.toLowerCase());
		const nameError = validateProfileName(this.newName, existingNames);
		if (nameError) {
			this.errorEl.textContent = nameError;
			this.errorEl.removeClass("vaultcrypt-hidden");
			return;
		}

		this.isSubmitting = true;
		this.submitBtn.setDisabled(true);
		try {
			await this.plugin.renameProfile(this.currentName, this.newName);
			this.close();
			this.onDone();
		} catch (e) {
			this.errorEl.textContent = `Error renaming: ${e instanceof Error ? e.message : String(e)}`;
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

export class DeleteProfileModal extends Modal {
	private onDone: () => void;
	private plugin: VaultCryptPlugin;
	private profileName: string;
	private config: ProfileConfig;
	private deleteFile = false;
	private errorEl: HTMLParagraphElement;
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

		this.isSubmitting = true;
		this.submitBtn.setDisabled(true);
		try {
			await this.plugin.deleteProfile(this.profileName, this.deleteFile);
			this.close();
			this.onDone();
		} catch (e) {
			this.errorEl.textContent = `Error deleting: ${e instanceof Error ? e.message : String(e)}`;
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
