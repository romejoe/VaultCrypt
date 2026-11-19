import {Notice, type TFile} from 'obsidian';
import type VaultCryptPlugin from './main';
import {parseVcTokens} from './inline-parser';
import {KeyringUnlockModal, UnlockModal} from './modals';

/** Check opened notes and the restored active note, without overlapping unlocks. */
export function registerNoteUnlock(plugin: VaultCryptPlugin): void {
	let active = true;
	let queue = Promise.resolve();
	const pending = new Map<string, Promise<void>>();
	plugin.register(() => { active = false; });

	const checkFile = (file: TFile | null): Promise<void> => {
		if (!active || !file || file.extension !== 'md') return Promise.resolve();
		const existing = pending.get(file.path);
		if (existing) return existing;
		const task = queue.then(async () => {
			if (!active) return;
			await unlockNoteProfiles(plugin, file, () => active);
		}).catch(error => {
			console.error('[VaultCrypt] Could not check note for locked profiles', error);
		}).finally(() => { pending.delete(file.path); });
		pending.set(file.path, task);
		queue = task;
		return task;
	};

	plugin.registerEvent(plugin.app.workspace.on('file-open', checkFile));
	plugin.app.workspace.onLayoutReady(() => {
		if (active && plugin.settings.security.autoUnlock) {
			void checkFile(plugin.app.workspace.getActiveFile());
		}
	});
}

async function unlockNoteProfiles(plugin: VaultCryptPlugin, file: TFile, isActive: () => boolean): Promise<void> {
	const content = await plugin.app.vault.read(file);
	if (!isActive()) return;
	const settings = plugin.settings;
	const lockedProfileIds = new Set(parseVcTokens(content)
		.map(token => token.profileId.toLowerCase())
		.filter(id => Object.prototype.hasOwnProperty.call(settings.profiles, id))
		.filter(id => !plugin.sessionService.isUnlocked(id)));

	if (settings.security.autoUnlock && lockedProfileIds.size > 0) {
		const beforeAutoUnlock = new Set(lockedProfileIds);
		const notice = new Notice('Unlocking saved profiles...', 0);
		try {
			await plugin.secretStorageService.autoUnlockProfiles(
				settings, lockedProfileIds, plugin.sessionService, plugin.keyringService,
			);
		} finally {
			notice.hide();
		}
		if (!isActive()) return;
		for (const id of beforeAutoUnlock) {
			if (!lockedProfileIds.has(id)) new Notice(`Profile "${id}" unlocked.`);
		}
	}

	const hasLockedManagedProfiles = [...lockedProfileIds].some(id => settings.profiles[id]?.managedByKeyring);
	if (hasLockedManagedProfiles && settings.keyringEnabled) {
		const notice = new Notice('Locked profiles detected. ', 5_000);
		const btn = notice.messageEl.createEl('button', {text: 'Unlock with keyring'});
		btn.addEventListener('click', () => {
			notice.hide();
			if (isActive()) new KeyringUnlockModal(plugin.app, plugin).open();
		});
	}
	for (const id of lockedProfileIds) {
		if (settings.profiles[id]?.managedByKeyring && settings.keyringEnabled) continue;
		const notice = new Notice(`Profile "${id}" is locked. `, 5_000);
		const btn = notice.messageEl.createEl('button', {text: 'Unlock'});
		btn.addEventListener('click', () => {
			notice.hide();
			if (isActive()) new UnlockModal(plugin.app, plugin, id).open();
		});
	}
}
