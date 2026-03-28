import {App, ButtonComponent, Modal, Setting} from 'obsidian';
import VaultCryptPlugin from '../main';

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
			(preselectedProfileId && lockedIds.includes(preselectedProfileId))
				? preselectedProfileId
				: lockedIds[0] ?? "";
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
