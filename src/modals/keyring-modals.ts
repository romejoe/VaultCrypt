import {App, ButtonComponent, Modal, Notice, Setting} from 'obsidian';
import VaultCryptPlugin, {VaultCryptState} from '../main';
import {VaultCryptSettings} from '../settings';
import {peek} from '@maverick-js/signals';

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
			});

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
			});

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
