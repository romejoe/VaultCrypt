import {App, PluginSettingTab, Setting} from "obsidian";
import VaultCryptPlugin from "./main";

export interface VaultCryptSettings {
	profiles: string[];
	security: {
		autoLockTimeout: number;
		clipboardClearTimer: number;
	};
	general: {
		vaultCryptDir: string;
		defaultProfile: string;
	};
}

export const DEFAULT_SETTINGS: VaultCryptSettings = {
	profiles: [],
	security: {
		autoLockTimeout: 300,
		clipboardClearTimer: 10
	},
	general: {
		vaultCryptDir: ".vaultcrypt",
		defaultProfile: ""
	}
}

export class VaultCryptSettingTab extends PluginSettingTab {
	plugin: VaultCryptPlugin;

	constructor(app: App, plugin: VaultCryptPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		// Profiles section
		new Setting(containerEl).setName("Profiles").setHeading();
		
		new Setting(containerEl)
			.setName('List of configured .kdbx profiles')
			.setDesc('Enter full paths to your .kdbx files')
			.addTextArea(text => text
				.setPlaceholder('Enter profile paths, one per line')
				.setValue(this.plugin.settings.profiles.join('\n'))
				.onChange(async (value) => {
					this.plugin.settings.profiles = value.split('\n').filter(p => p.trim() !== '');
					await this.plugin.saveSettings();
				}));

		// Security section
		new Setting(containerEl).setName("Security").setHeading();
		
		new Setting(containerEl)
			.setName('Auto-lock timeout (seconds)')
			.setDesc('Time in seconds before automatically locking the vault')
			.addSlider(slider => slider
				.setLimits(30, 1800, 30)
				.setValue(this.plugin.settings.security.autoLockTimeout)
				.onChange(async (value) => {
					this.plugin.settings.security.autoLockTimeout = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Clipboard clear timer (seconds)')
			.setDesc('Time in seconds before clearing clipboard after copying secret')
			.addSlider(slider => slider
				.setLimits(1, 60, 1)
				.setValue(this.plugin.settings.security.clipboardClearTimer)
				.onChange(async (value) => {
					this.plugin.settings.security.clipboardClearTimer = value;
					await this.plugin.saveSettings();
				}));

		// General section
		// eslint-disable-next-line obsidianmd/settings-tab/no-problematic-settings-headings
		new Setting(containerEl).setName("General").setHeading();
		
		new Setting(containerEl)
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setName('VaultCrypt directory path')
			.setDesc('Path to the .vaultcrypt directory where configuration is stored')
			.addText(text => text
				.setPlaceholder('.vaultcrypt')
				.setValue(this.plugin.settings.general.vaultCryptDir)
				.onChange(async (value) => {
					this.plugin.settings.general.vaultCryptDir = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Default profile')
			.setDesc('The default profile to use for unlocking')
			.addDropdown(dropdown => dropdown
				.addOptions(this.plugin.settings.profiles.reduce((acc, profile) => {
					acc[profile] = profile;
					return acc;
				}, {} as Record<string, string>))
				.setValue(this.plugin.settings.general.defaultProfile)
				.onChange(async (value) => {
					this.plugin.settings.general.defaultProfile = value;
					await this.plugin.saveSettings();
				}));
	}
}
