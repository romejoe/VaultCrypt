import {App, ButtonComponent, Modal, Notice, Setting, ToggleComponent} from 'obsidian';
import VaultCryptPlugin from '../main';

export class UnlockModal extends Modal {
	private plugin: VaultCryptPlugin;
	private selectedProfileId: string;
	private password = "";
	private useKeyring = false;
	private rememberPassword = false;
	private keyringToggleSetting: Setting | null = null;
	private passwordSetting!: Setting;
	private passwordInputEl!: HTMLInputElement;
	private rememberToggle: ToggleComponent | null = null;
	private errorEl!: HTMLParagraphElement;
	private progressEl!: HTMLParagraphElement;
	private progressTimer: number | null = null;
	private isSubmitting = false;
	private submitBtn!: ButtonComponent;
	private cancelBtn!: ButtonComponent;
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
			(preselectedProfileId && lockedIds.includes(preselectedProfileId))
				? preselectedProfileId
				: lockedIds[0] ?? "";
		// Default to keyring mode if the pre-selected profile is managed by keyring
		this.useKeyring = plugin.settings.keyringEnabled &&
			(plugin.settings.profiles[this.selectedProfileId]?.managedByKeyring ?? false);
	}

	onOpen() {
		const {contentEl} = this;
		this.titleEl.setText("Unlock profile");

		const profiles = this.plugin.settings.profiles;
		const lockedIds = Object.keys(profiles).filter(
			id => !this.plugin.sessionService.isUnlocked(id)
		);

		if (lockedIds.length === 0) {
			contentEl.createEl("p", {text: "All profiles are already unlocked."});
			new Setting(contentEl)
				.addButton(btn => btn.setButtonText("Close").setCta().onClick(() => this.close()));
			return;
		}

		new Setting(contentEl)
			.setName("Profile")
			.addDropdown(dd => {
				for (const id of lockedIds) {
					dd.addOption(id, id);
				}
				dd.setValue(this.selectedProfileId).onChange(value => {
					this.selectedProfileId = value;
					this.updateKeyringSection();
					this.clearPassword();
					this.refreshSavedPasswordState();
				});
			});

		if (this.plugin.settings.keyringEnabled) {
			this.keyringToggleSetting = new Setting(contentEl)
				.setName("Use keyring master password")
				.setDesc("Unlock using the master keyring password instead of the profile password")
				.addToggle((toggle: ToggleComponent) => {
					toggle.setValue(this.useKeyring)
						.onChange((value: boolean) => {
							this.useKeyring = value;
							this.clearPassword();
							this.updatePasswordLabel();
							this.refreshSavedPasswordState();
						});
				});
		}

		this.passwordSetting = new Setting(contentEl)
			.setName(this.useKeyring ? "Keyring master password" : "Profile password")
			.addText(text => {
				text.inputEl.type = "password";
				text.inputEl.focus();
				this.passwordInputEl = text.inputEl;
				text.setPlaceholder("Enter password")
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

		new Setting(contentEl)
			.setName("Remember password")
			.setDesc("Save the password in Obsidian's secure secret storage")
			.addToggle(toggle => {
				this.rememberToggle = toggle;
				toggle.setValue(false).onChange(value => {
					this.rememberPassword = value;
				});
			});

		this.errorEl = contentEl.createEl("p", {cls: "mod-warning"});
		this.errorEl.addClass("vaultcrypt-hidden");

		new Setting(contentEl)
			.addButton(btn => {
				this.cancelBtn = btn;
				btn.setButtonText("Cancel").onClick(() => this.close());
			})
			.addButton(btn => {
				this.submitBtn = btn;
				btn.setButtonText("Unlock")
					.setCta()
					.onClick(() => this.submit());
			});

		this.progressEl = contentEl.createEl("p", {cls: "vaultcrypt-unlock-progress vaultcrypt-hidden"});

		this.updateKeyringSection();
		this.refreshSavedPasswordState();
	}

	private isSelectedProfileKeyringManaged(): boolean {
		return this.plugin.settings.keyringEnabled &&
			(this.plugin.settings.profiles[this.selectedProfileId]?.managedByKeyring ?? false);
	}

	private updateKeyringSection() {
		if (!this.keyringToggleSetting) return;
		const isManaged = this.isSelectedProfileKeyringManaged();
		this.keyringToggleSetting.settingEl.style.display = isManaged ? '' : 'none';
		if (!isManaged && this.useKeyring) {
			this.useKeyring = false;
			(this.keyringToggleSetting.components[0] as ToggleComponent).setValue(false);
			this.clearPassword();
		}
		this.updatePasswordLabel();
	}

	private updatePasswordLabel() {
		this.passwordSetting.setName(this.useKeyring ? "Keyring master password" : "Profile password");
	}

	private clearPassword() {
		this.password = "";
		if (this.passwordInputEl) this.passwordInputEl.value = "";
	}

	/** Pre-fills the password field and remember toggle from SecretStorage. */
	private refreshSavedPasswordState() {
		const svc = this.plugin.secretStorageService;
		const saved = this.useKeyring
			? svc.loadKeyringPassword()
			: (this.selectedProfileId ? svc.loadProfilePassword(this.selectedProfileId) : null);

		if (saved) {
			this.password = saved;
			this.passwordInputEl.value = saved;
			this.rememberPassword = true;
		} else {
			this.rememberPassword = false;
		}
		this.rememberToggle?.setValue(this.rememberPassword);
	}

	private clearProgressTimer() {
		if (this.progressTimer !== null) {
			window.clearInterval(this.progressTimer);
			this.progressTimer = null;
		}
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
			this.showError("Password is required.");
			return;
		}

		// Snapshot mutable form state before any await to prevent race conditions
		// if the user changes the dropdown or toggle while the async flow is in flight.
		const profileId = this.selectedProfileId;
		const submittedPassword = this.password;
		const useKeyring = this.useKeyring;
		const remember = this.rememberPassword;

		const config = this.plugin.settings.profiles[profileId];
		if (!config) {
			this.showError("Profile not found.");
			return;
		}

		this.isSubmitting = true;
		this.submitBtn.setDisabled(true);
		this.cancelBtn.setDisabled(true);
		this.submitBtn.setButtonText("Unlocking...");
		const startTime = Date.now();
		this.progressEl.setText("Opening database...");
		this.progressEl.removeClass("vaultcrypt-hidden");
		this.progressTimer = window.setInterval(() => {
			const elapsed = Math.round((Date.now() - startTime) / 1000);
			this.progressEl.setText(`Opening database... (${elapsed}s)`);
		}, 1000);
		try {
			if (useKeyring) {
				let passwords: Map<string, string>;
				try {
					passwords = await this.plugin.keyringService.getProfilePasswords(
						this.plugin.settings.masterKeyringPath,
						submittedPassword,
						[profileId],
					);
				} catch (e) {
					console.error(e);
					this.showError("Incorrect keyring master password or corrupted keyring.");
					return;
				}
				const profilePassword = passwords.get(profileId);
				if (!profilePassword) {
					this.showError("Profile not found in keyring.");
					return;
				}
				try {
					await this.plugin.sessionService.unlockProfile(profileId, config, profilePassword);
				} catch (e) {
					console.error(e);
					this.showError("Stored profile password is incorrect or corrupted.");
					return;
				}
				// Save or forget the keyring password based on the remember toggle
				const kSaved = remember
					? this.plugin.secretStorageService.saveKeyringPassword(submittedPassword)
					: this.plugin.secretStorageService.forgetKeyringPassword();
				if (!kSaved) new Notice('Could not update saved keyring password in secret storage.');
			} else {
				await this.plugin.sessionService.unlockProfile(profileId, config, submittedPassword);
				// Save or forget the profile password based on the remember toggle
				const pSaved = remember
					? this.plugin.secretStorageService.saveProfilePassword(profileId, submittedPassword)
					: this.plugin.secretStorageService.forgetProfilePassword(profileId);
				if (!pSaved) new Notice('Could not update saved password in secret storage.');
			}
			this.close();
			this.onDone?.(profileId);
		} catch (e) {
			console.error(e);
			this.showError("Incorrect password or corrupted database.");
		} finally {
			this.isSubmitting = false;
			this.clearProgressTimer();
			this.progressEl.addClass("vaultcrypt-hidden");
			this.submitBtn.setButtonText("Unlock");
			this.submitBtn.setDisabled(false);
			this.cancelBtn.setDisabled(false);
		}
	}

	onClose() {
		this.clearProgressTimer();
		this.contentEl.empty();
	}
}
