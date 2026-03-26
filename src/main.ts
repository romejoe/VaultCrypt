import { Menu, Notice, Plugin, TFile } from 'obsidian';
import { DEFAULT_SETTINGS, ProfileConfig, VaultCryptSettings, VaultCryptSettingTab } from './settings';
import { KdbxService, KdbxVersion } from './kdbx-service';
import { ProfileService } from './profile-service';
import { UnlockSessionService } from './unlock-session';
import { UnlockModal } from './modals';
import { VaultCryptProfile, VaultCryptState } from './types';

export type { VaultCryptProfile, VaultCryptState };

export default class VaultCryptPlugin extends Plugin {
	settings: VaultCryptSettings;
	statusBarItem: HTMLElement;
	vaultCryptState: VaultCryptState;
	kdbxService: KdbxService;
	profileService: ProfileService;
	sessionService: UnlockSessionService;

	async onload() {
		await this.loadSettings();
		this.vaultCryptState = {
			profiles: [],
			currentProfile: null,
			isLocked: true,
		};
		// KdbxService must be instantiated first — its constructor registers the
		// Argon2 implementation globally with kdbxweb (needed by UnlockSessionService).
		this.kdbxService = new KdbxService(this.app.vault.adapter);
		this.sessionService = new UnlockSessionService(this.app.vault.adapter);
		this.profileService = new ProfileService(
			this.settings,
			this.app.vault.adapter,
			this.kdbxService,
			this.vaultCryptState,
			() => this.saveSettings(),
		);

		// Populate runtime state from persisted settings
		this.initRuntimeState();

		// Ensure the .vaultcrypt directory exists
		await this.profileService.ensureVaultCryptDir();

		// Wire session events → sync runtime state + update UI
		this.sessionService.onUnlock(id => {
			this.syncProfileLockState(id, false);
			this.updateStatusBar();
		});
		this.sessionService.onLock(id => {
			this.syncProfileLockState(id, true);
			this.updateStatusBar();
			new Notice(`VaultCrypt: profile "${id}" locked`);
		});

		// Ribbon icon → unlock modal
		// eslint-disable-next-line obsidianmd/ui/sentence-case
		this.addRibbonIcon('lock', 'VaultCrypt', () => {
			new UnlockModal(this.app, this).open();
		});

		// Status bar
		this.statusBarItem = this.addStatusBarItem();
		this.updateStatusBar();

		// Status bar click → lock menu
		this.registerDomEvent(this.statusBarItem, 'click', (evt: MouseEvent) => {
			const menu = new Menu();
			const unlocked = this.vaultCryptState.profiles.filter(p => !p.isLocked);
			const locked = this.vaultCryptState.profiles.filter(p => p.isLocked);

			for (const p of locked) {
				menu.addItem(item => item
					.setTitle(`Unlock ${p.name}`)
					.setIcon('lock-open')
					.onClick(() => new UnlockModal(this.app, this, p.id).open()));
			}
			for (const p of unlocked) {
				menu.addItem(item => item
					.setTitle(`Lock ${p.name}`)
					.setIcon('lock')
					.onClick(() => this.sessionService.lockProfile(p.id)));
			}
			if (unlocked.length > 1) {
				menu.addSeparator();
				menu.addItem(item => item
					.setTitle('Lock all')
					.setIcon('lock')
					.onClick(() => this.sessionService.lockAll()));
			}
			menu.showAtMouseEvent(evt);
		});

		// Commands
		this.addCommand({
			id: 'vault-crypt-unlock-profile',
			name: 'Unlock profile',
			callback: () => {
				new UnlockModal(this.app, this).open();
			}
		});

		this.addCommand({
			id: 'vault-crypt-unlock-all',
			name: 'Unlock all profiles',
			callback: () => {
				const lockedIds = this.vaultCryptState.profiles
					.filter(p => p.isLocked)
					.map(p => p.id);
				this.unlockNextLocked(lockedIds);
			}
		});

		this.addCommand({
			id: 'vault-crypt-lock-profile',
			name: 'Lock profile',
			callback: () => {
				const unlocked = this.vaultCryptState.profiles.filter(p => !p.isLocked);
				if (unlocked.length === 0) {
					// eslint-disable-next-line obsidianmd/ui/sentence-case
					new Notice('VaultCrypt: no profiles are currently unlocked.');
					return;
				}
				if (unlocked.length === 1) {
					this.sessionService.lockProfile(unlocked[0]!.id);
					return;
				}
				// Multiple unlocked — show a menu to pick which
				const menu = new Menu();
				for (const p of unlocked) {
					menu.addItem(item => item
						.setTitle(`Lock ${p.name}`)
						.setIcon('lock')
						.onClick(() => this.sessionService.lockProfile(p.id)));
				}
				// Position near the status bar (approximate)
				menu.showAtPosition({ x: window.innerWidth / 2, y: window.innerHeight - 40 });
			}
		});

		this.addCommand({
			id: 'vault-crypt-lock-all',
			name: 'Lock all profiles',
			callback: () => {
				this.sessionService.lockAll();
			}
		});

		this.addCommand({
			id: 'vault-crypt-insert-secret',
			name: 'Insert secret',
			callback: () => {
				new Notice('Insert secret command executed');
				// Stub — implemented in a later issue
			}
		});

		// Auto-prompt when a note containing {{vc:...}} references is opened
		this.registerEvent(this.app.workspace.on('file-open', async (file: TFile | null) => {
			if (!file || file.extension !== 'md') return;
			const content = await this.app.vault.read(file);
			const matches = [...content.matchAll(/\{\{vc:([^:}]+)/g)];
			const lockedProfileIds = new Set(
				matches
					.map(m => (m[1] ?? '').toLowerCase())
					.filter(id => this.settings.profiles[id] && !this.sessionService.isUnlocked(id))
			);
			for (const profileId of lockedProfileIds) {
				const notice = new Notice(`VaultCrypt: profile "${profileId}" is locked. `, 0);
				const btn = notice.messageEl.createEl('button', { text: 'Unlock' });
				btn.addEventListener('click', () => {
					notice.hide();
					new UnlockModal(this.app, this, profileId).open();
				});
			}
		}));

		// Settings tab
		this.addSettingTab(new VaultCryptSettingTab(this.app, this));
	}

	onunload() {
		this.sessionService.lockAll();
	}

	async loadSettings() {
		const loaded = await this.loadData() as Partial<VaultCryptSettings> & { profiles?: unknown };
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);

		// Migrate old profiles format (string array) to new Record<string, ProfileConfig>
		if (Array.isArray(this.settings.profiles)) {
			const oldPaths = this.settings.profiles as unknown as string[];
			this.settings.profiles = {};
			if (oldPaths.length > 0) {
				new Notice('Profile paths from the old format were removed. Please re-add your profiles.');
			}
		}

		// Migrate old clipboardClearTimer to clipboardClearSeconds
		const security = this.settings.security as VaultCryptSettings['security'] & { clipboardClearTimer?: number };
		if (security.clipboardClearTimer !== undefined && security.clipboardClearSeconds === DEFAULT_SETTINGS.security.clipboardClearSeconds) {
			security.clipboardClearSeconds = security.clipboardClearTimer;
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// ── Profile delegation ────────────────────────────────────────────────────

	async addProfile(name: string, password: string, version: KdbxVersion): Promise<void> {
		await this.profileService.addProfile(name, password, version);
		this.initRuntimeState();
		this.updateStatusBar();
	}

	async editProfile(name: string, updates: Partial<Pick<ProfileConfig, 'autoLockMinutes' | 'defaultField'>>): Promise<void> {
		await this.profileService.editProfile(name, updates);
	}

	async renameProfile(oldName: string, newName: string): Promise<void> {
		await this.profileService.renameProfile(oldName, newName);
		this.initRuntimeState();
		this.updateStatusBar();
	}

	async deleteProfile(name: string, deleteFile: boolean): Promise<void> {
		const key = name.toLowerCase();
		// Lock the profile before deletion so it's wiped from memory
		this.sessionService.lockProfile(key);
		await this.profileService.deleteProfile(name, deleteFile);
		this.initRuntimeState();
		this.updateStatusBar();
	}

	// ── Runtime state ─────────────────────────────────────────────────────────

	/**
	 * Rebuilds vaultCryptState.profiles from the persisted settings, preserving
	 * the current lock/unlock state of profiles that are already open.
	 */
	private initRuntimeState(): void {
		this.vaultCryptState.profiles = Object.entries(this.settings.profiles).map(([id, cfg]) => {
			const existing = this.vaultCryptState.profiles.find(p => p.id === id);
			return {
				id,
				name: id,
				path: cfg.path,
				kdbxVersion: cfg.kdbxVersion,
				autoLockMinutes: cfg.autoLockMinutes,
				isLocked: existing ? existing.isLocked : !this.sessionService.isUnlocked(id),
				lastUnlock: existing?.lastUnlock ?? null,
			};
		});
		// currentProfile: keep if still present, otherwise null
		if (this.vaultCryptState.currentProfile) {
			const still = this.vaultCryptState.profiles.find(
				p => p.id === this.vaultCryptState.currentProfile!.id
			);
			this.vaultCryptState.currentProfile = still ?? null;
		}
	}

	/** Updates the isLocked flag and lastUnlock date for a profile in runtime state. */
	private syncProfileLockState(profileId: string, isLocked: boolean): void {
		const profile = this.vaultCryptState.profiles.find(p => p.id === profileId);
		if (!profile) return;
		profile.isLocked = isLocked;
		if (!isLocked) profile.lastUnlock = new Date();
		// Keep the top-level isLocked in sync (true only when all profiles are locked)
		this.vaultCryptState.isLocked = this.vaultCryptState.profiles.every(p => p.isLocked);
	}

	/**
	 * Opens the UnlockModal for each locked profile in sequence.
	 * After one profile is unlocked, moves on to the next.
	 */
	private unlockNextLocked(remaining: string[]): void {
		if (remaining.length === 0) return;
		const [next, ...rest] = remaining;
		new UnlockModal(this.app, this, next, () => {
			this.unlockNextLocked(rest);
		}).open();
	}

	// ── UI helpers ────────────────────────────────────────────────────────────

	updateStatusBar() {
		const profiles = this.vaultCryptState.profiles;
		if (profiles.length === 0) {
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			this.statusBarItem.setText('🔒 VaultCrypt');
			return;
		}
		const parts = profiles.map(p => (p.isLocked ? '🔒 ' : '🔓 ') + p.name);
		this.statusBarItem.setText(parts.join(' | '));
	}
}
