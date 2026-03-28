import {App, ButtonComponent, Modal, Setting, ToggleComponent} from 'obsidian';
import VaultCryptPlugin from '../main';

export class UnlockModal extends Modal {
	private plugin: VaultCryptPlugin;
	private selectedProfileId: string;
	private password = "";
	private useKeyring = false;
	private keyringToggleSetting: Setting | null = null;
	private passwordSetting!: Setting;
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
							this.updatePasswordLabel();
						});
				});
		}

		this.passwordSetting = new Setting(contentEl)
			.setName(this.useKeyring ? "Keyring master password" : "Profile password")
			.addText(text => {
				text.inputEl.type = "password";
				text.inputEl.focus();
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

		this.updateKeyringSection();
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
		}
		this.updatePasswordLabel();
	}

	private updatePasswordLabel() {
		this.passwordSetting.setName(this.useKeyring ? "Keyring master password" : "Profile password");
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

		const config = this.plugin.settings.profiles[this.selectedProfileId];
		if (!config) {
			this.showError("Profile not found.");
			return;
		}

		this.isSubmitting = true;
		this.submitBtn.setDisabled(true);
		try {
			if (this.useKeyring) {
				let passwords: Map<string, string>;
				try {
					passwords = await this.plugin.keyringService.getProfilePasswords(
						this.plugin.settings.masterKeyringPath,
						this.password,
						[this.selectedProfileId],
					);
				} catch (e) {
					console.error(e);
					this.showError("Incorrect keyring master password or corrupted keyring.");
					return;
				}
				const profilePassword = passwords.get(this.selectedProfileId);
				if (!profilePassword) {
					this.showError("Profile not found in keyring.");
					return;
				}
				try {
					await this.plugin.sessionService.unlockProfile(this.selectedProfileId, config, profilePassword);
				} catch (e) {
					console.error(e);
					this.showError("Stored profile password is incorrect or corrupted.");
					return;
				}
			} else {
				await this.plugin.sessionService.unlockProfile(this.selectedProfileId, config, this.password);
			}
			this.close();
			this.onDone?.(this.selectedProfileId);
		} catch (e) {
			console.error(e);
			this.showError("Incorrect password or corrupted database.");
		} finally {
			this.isSubmitting = false;
			this.submitBtn.setDisabled(false);
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
