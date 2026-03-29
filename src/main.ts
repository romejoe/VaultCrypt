import {Editor, MarkdownView, Menu, Notice, Plugin, TFile} from 'obsidian';
import {DEFAULT_SETTINGS, ProfileConfig, VaultCryptSettings, VaultCryptSettingTab} from './settings';
import {KdbxService, KdbxVersion} from './kdbx-service';
import {ProfileService} from './profile-service';
import {UnlockSessionService} from './unlock-session';
import {KeyringService} from './keyring-service';
import {UnlockModal, KeyringUnlockModal, InsertSecretModal, SearchSecretsModal} from './modals';
import {VaultCryptProfile, VaultCryptState} from './types';
import {buildEditorExtension, refreshChipsEffect} from './editor-extension';
import {parseVcTokens, processVcTokensInDom, resolveFieldName} from './inline-parser';
import {buildChipElement} from './chip-component';
import {buildCopyTextFromSelection} from './clipboard-intercept';
import {EditorView} from '@codemirror/view';
import {Extension} from "@codemirror/state";
import {computed, effect, peek, signal, StopEffect} from "@maverick-js/signals";
import {deepFreeze, DeepReadonly} from "./utils";

export type {VaultCryptProfile, VaultCryptState};

declare module 'obsidian' {
	interface View {
		// Expose the EditorView on the Obsidian MarkdownView for our editor extension to consume.
		editor?: Editor & {
			cm?: EditorView;
		}
	}
}

const DEFAULT_STATE: VaultCryptState = {
	profiles: [],
	currentProfile: null,
	isLocked: true,
}

interface ElectronClipboard {
	writeText(s: string): void;

	readText(): string;
}

function getElectronClipboard(): ElectronClipboard | null {
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any,@typescript-eslint/no-unsafe-call,@typescript-eslint/no-unsafe-return,@typescript-eslint/no-unsafe-member-access
		return (window as any).require?.('electron')?.clipboard ?? null;
	} catch {
		return null;
	}
}

export default class VaultCryptPlugin extends Plugin {

	private readonly _settings$ = signal<VaultCryptSettings>(DEFAULT_SETTINGS);
	readonly settings$ = computed(() => {
		return deepFreeze(structuredClone(this._settings$()));
	});
	private clearClipboardTimeouts: number[] = [];
	private effects: StopEffect[] = [];


	get settings(): DeepReadonly<VaultCryptSettings> {
		return peek(this.settings$);
	}

	statusBarItem?: HTMLElement;
	private readonly _vaultCryptState$ = signal<VaultCryptState>(DEFAULT_STATE);
	readonly vaultCryptState$ = computed(() => {
		return deepFreeze(structuredClone(this._vaultCryptState$()));
	});

	/*
	 * vaultCryptState is the runtime state of the plugin, derived from persisted settings but enriched with volatile properties like isLocked and lastUnlock that aren't stored on disk.
	 * @deprecated Use vaultCryptState$ instead.
	 */
	get vaultCryptState(): DeepReadonly<VaultCryptState> {
		return peek(this.vaultCryptState$);
	}

	kdbxService?: KdbxService;
	profileService!: ProfileService;
	sessionService!: UnlockSessionService;
	keyringService!: KeyringService;
	lastUsedProfileId = '';
	private editorExtension?: Extension;

	async onload() {
		await this.loadSettings();
		this._vaultCryptState$.set({
			profiles: [],
			currentProfile: null,
			isLocked: true,
		});
		// KdbxService must be instantiated first — its constructor registers the
		// Argon2 implementation globally with kdbxweb (needed by UnlockSessionService).
		this.kdbxService = new KdbxService(this.app.vault.adapter);
		this.sessionService = new UnlockSessionService(this.app.vault.adapter);
		this.keyringService = new KeyringService(this.app.vault.adapter);
		this.profileService = new ProfileService(
			this.settings$,
			this.app.vault.adapter,
			this.kdbxService,
			this.vaultCryptState$,
			(patcher) => {
				this.patchSettings(patcher);
			},
			(mutator) => {
				this.mutateState(mutator);
			}
		);

		// Populate runtime state from persisted settings
		this.initRuntimeState();

		// Ensure the .vaultcrypt directory exists
		await this.profileService.ensureVaultCryptDir();

		// Wire session events → sync runtime state + update UI
		this.sessionService.onUnlock(id => {
			this.syncProfileLockState(id, false);
			this.refreshAllEditorChips();
		});
		this.sessionService.onLock(id => {
			this.syncProfileLockState(id, true);
			new Notice(`Profile "${id}" is locked`);
			this.refreshAllEditorChips();

			// This is very heavy-handed, is probably fragile and bad practice, but it works for now.
			document.querySelectorAll('.vaultcrypt-chip').forEach(el => {
				el.dispatchEvent(new CustomEvent('vc-token-event', {
					detail: {
						type: 'profile-lock',
						profileId: id,
					}
				}));
			});
		});

		// Ribbon icon → unlock modal (prefers keyring when available)
		// eslint-disable-next-line obsidianmd/ui/sentence-case
		this.addRibbonIcon('lock', 'VaultCrypt', () => {
			if (this.shouldUseKeyringUnlock()) {
				new KeyringUnlockModal(this.app, this, () => {
					// Chain to per-profile unlock for non-managed locked profiles
					const remaining = this.vaultCryptState.profiles
						.filter(p => p.isLocked && !p.managedByKeyring)
						.map(p => p.id);
					this.unlockNextLocked(remaining);
				}).open();
			} else {
				new UnlockModal(this.app, this).open();
			}
		});

		// Status bar
		this.statusBarItem = this.addStatusBarItem();

		// Status bar click → lock menu
		this.registerDomEvent(this.statusBarItem, 'click', (evt: MouseEvent) => {
			const menu = new Menu();
			const state = peek(this.vaultCryptState$);
			const unlocked = state.profiles.filter(p => !p.isLocked);
			const locked = state.profiles.filter(p => p.isLocked);

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
				if (this.shouldUseKeyringUnlock()) {
					new KeyringUnlockModal(this.app, this, () => {
						// Chain to per-profile unlock for non-managed locked profiles
						const remaining = this.vaultCryptState.profiles
							.filter(p => p.isLocked && !p.managedByKeyring)
							.map(p => p.id);
						this.unlockNextLocked(remaining);
					}).open();
				} else {
					const lockedIds = this.vaultCryptState.profiles
						.filter(p => p.isLocked)
						.map(p => p.id);
					this.unlockNextLocked(lockedIds);
				}
			}
		});

		this.addCommand({
			id: 'vault-crypt-lock-profile',
			name: 'Lock profile',
			callback: () => {
				const unlocked = this.vaultCryptState.profiles.filter(p => !p.isLocked);
				if (unlocked.length === 0) {
					new Notice('No profiles are currently unlocked.');
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
				menu.showAtPosition({x: window.innerWidth / 2, y: window.innerHeight - 40});
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
			id: 'vault-crypt-copy-focused-chip',
			name: 'Copy secret under cursor',
			editorCallback: (editor: Editor) => {
				const cursor = editor.getCursor();
				const lineText = editor.getLine(cursor.line);
				const tokens = parseVcTokens(lineText);
				const token = tokens.find(t => cursor.ch >= t.from && cursor.ch < t.to);
				if (!token) {
					new Notice('No secret token under cursor');
					return;
				}
				const profileId = token.profileId.toLowerCase();
				const config = this.settings.profiles[profileId];
				const fieldName = resolveFieldName(token, config?.defaultField ?? 'Password');
				const value = this.sessionService?.getFieldValue(profileId, token.entryPath, fieldName);
				if (value === null || value === undefined) {
					new Notice('Could not read value — is the profile unlocked?');
					return;
				}
				navigator.clipboard.writeText(value).then(() => {
					const secs = this.settings.security.clipboardClearSeconds;
					const msg = (secs > 0) ? `Copied to clipboard (clears in ${secs}s)` : 'Copied to clipboard';
					new Notice(msg, 3000);
					if (secs > 0) {
						this.scheduleClearClipboardTime(value, secs);
					}
				}).catch(() => new Notice('Failed to copy to clipboard'));
			}
		});

		this.addCommand({
			id: 'vault-crypt-insert-secret',
			name: 'Insert secret',
			editorCallback: (editor: Editor) => {
				new InsertSecretModal(this.app, this, editor).open();
			}
		});

		this.addCommand({
			id: 'vault-crypt-search-secrets',
			name: 'Search secrets',
			editorCallback: (editor: Editor) => {
				new SearchSecretsModal(this.app, this, editor).open();
			}
		});

		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor) => {
				menu.addItem(item => item
					// eslint-disable-next-line obsidianmd/ui/sentence-case
					.setTitle('VaultCrypt: Insert secret here')
					.setIcon('key')
					.onClick(() => new InsertSecretModal(this.app, this, editor).open()));
			})
		);

		// Auto-prompt when a note containing {{vc:...}} references is opened
		this.registerEvent(this.app.workspace.on('file-open', async (file: TFile | null) => {
			if (!file || file.extension !== 'md') return;
			const content = await this.app.vault.read(file);
			const matches = [...content.matchAll(/\{\{vc:([^:}]+)/g)];

			const settings = peek(this.settings$);
			const lockedProfileIds = new Set(
				matches
					.map(m => {
						const identifierString = (m[1] ?? '').toLowerCase();
						if (identifierString === '') return null;
						const profileIdEndIndex = identifierString.indexOf("/");

						const profileId = profileIdEndIndex < 0 ? '' : identifierString.substring(0, profileIdEndIndex);
						if (profileId in settings.profiles) {
							return profileId;
						}
						return null;
					})
					.filter((profileId): profileId is string => !!profileId)
					.filter(profileId => !this.sessionService.isUnlocked(profileId))
			);
			// Check if any locked profiles are keyring-managed
			const hasLockedManagedProfiles = [...lockedProfileIds].some(
				id => settings.profiles[id]?.managedByKeyring
			);

			if (hasLockedManagedProfiles && settings.keyringEnabled) {
				const notice = new Notice('Locked profiles detected. ', 5_000);
				const btn = notice.messageEl.createEl('button', {text: 'Unlock with keyring'});
				btn.addEventListener('click', () => {
					notice.hide();
					new KeyringUnlockModal(this.app, this).open();
				});
			}

			for (const profileId of lockedProfileIds) {
				if (settings.profiles[profileId]?.managedByKeyring && settings.keyringEnabled) continue;
				const notice = new Notice(`Profile "${profileId}" is locked. `, 5_000);
				const btn = notice.messageEl.createEl('button', {text: 'Unlock'});
				btn.addEventListener('click', () => {
					notice.hide();
					new UnlockModal(this.app, this, profileId).open();
				});
			}
		}));

		// CodeMirror extension for source / live preview decoration
		this.registerEditorExtension(buildEditorExtension(this));

		// Reading mode post-processor
		this.registerMarkdownPostProcessor((el) => {
			processVcTokensInDom(el, (token) => buildChipElement(token, this));
		});

		// Clipboard interception for reading mode (CM6 is handled in editor-extension.ts)
		this.registerDomEvent(document, 'copy', (event: ClipboardEvent) => {
			const sel = window.getSelection();
			if (!sel || sel.rangeCount === 0) return;

			// Skip if selection is inside a CM6 editor (handled by the editor extension)
			const ancestor = sel.getRangeAt(0).commonAncestorContainer;
			const container = ancestor instanceof HTMLElement ? ancestor : ancestor.parentElement;
			if (container?.closest('.cm-editor')) return;

			const copyText = buildCopyTextFromSelection(sel, this);
			if (copyText === null) return;

			event.clipboardData?.setData('text/plain', copyText);
			event.preventDefault();
		});

		// Settings tab
		this.addSettingTab(new VaultCryptSettingTab(this.app, this));

		this.effects = [
			effect(() => {
				const settings = this.settings$();
				this.refreshAllEditorChips();
				this.app.workspace.getActiveViewOfType(MarkdownView)?.previewMode.rerender(true);
				this.dispatchSaveSettings(settings);
			}),
			effect(() => {
				const profiles = this.vaultCryptState$().profiles;
				if (!this.statusBarItem) {
					return;
				}
				if (profiles.length === 0) {
					// eslint-disable-next-line obsidianmd/ui/sentence-case
					this.statusBarItem.setText('🔒 VaultCrypt');
					return;
				}
				const parts = profiles.map(p => (p.isLocked ? '🔒 ' : '🔓 ') + p.name);
				this.statusBarItem.setText(parts.join(' | '));
			})
		]

	}

	onunload() {
		for (const effect of this.effects) {
			effect?.();
		}
		for (const timeoutId of this.clearClipboardTimeouts) {
			window.clearTimeout(timeoutId);
		}
		this.sessionService?.lockAll();
	}

	async loadSettings() {
		const loaded = await this.loadData() as Partial<VaultCryptSettings> | null;
		const newSettings: VaultCryptSettings = {
			...structuredClone(DEFAULT_SETTINGS),
			...loaded,
			general: {
				...DEFAULT_SETTINGS.general,
				...(loaded?.general ?? {}),
			},
			security: {
				...DEFAULT_SETTINGS.security,
				...(loaded?.security ?? {}),
			},
			profiles: (loaded?.profiles ?? structuredClone(DEFAULT_SETTINGS.profiles)),
		};

		// Migrate old profiles format (string array) to new Record<string, ProfileConfig>
		if (Array.isArray(newSettings.profiles)) {
			const oldPaths = newSettings.profiles as unknown as string[];
			newSettings.profiles = {};
			if (oldPaths.length > 0) {
				new Notice('Profile paths from the old format were removed. Please re-add your profiles.');
			}
		}

		// Migrate: ensure keyringEnabled exists
		if (newSettings.keyringEnabled === undefined) {
			newSettings.keyringEnabled = false;
		}

		// Migrate: ensure managedByKeyring exists on all profiles
		for (const config of Object.values(newSettings.profiles)) {
			if ((config as ProfileConfig & {managedByKeyring?: boolean}).managedByKeyring === undefined) {
				config.managedByKeyring = false;
			}
		}

		// Migrate old clipboardClearTimer to clipboardClearSeconds
		const security = newSettings.security as VaultCryptSettings['security'] & { clipboardClearTimer?: number };
		if (security.clipboardClearTimer !== undefined && security.clipboardClearSeconds === DEFAULT_SETTINGS.security.clipboardClearSeconds) {
			security.clipboardClearSeconds = security.clipboardClearTimer;
		}

		this._settings$.set(newSettings);
	}

	private async saveSettings(settings: DeepReadonly<VaultCryptSettings>) {
		await this.saveData(settings);
	}

	// ── Profile delegation ────────────────────────────────────────────────────

	async addProfile(name: string, password: string, version: KdbxVersion): Promise<void> {
		await this.profileService?.addProfile(name, password, version);
		this.initRuntimeState();
	}

	async editProfile(name: string, updates: Partial<Pick<ProfileConfig, 'autoLockMinutes' | 'defaultField'>>): Promise<void> {
		await this.profileService.editProfile(name, updates);
	}

	async renameProfile(oldName: string, newName: string): Promise<void> {
		await this.profileService.renameProfile(oldName, newName);
		this.initRuntimeState();
	}

	async deleteProfile(name: string, deleteFile: boolean): Promise<void> {
		const key = name.toLowerCase();
		// Lock the profile before deletion so it's wiped from memory
		this.sessionService.lockProfile(key);
		await this.profileService.deleteProfile(name, deleteFile);
		this.initRuntimeState();
	}

	// ── Runtime state ─────────────────────────────────────────────────────────

	/**
	 * Rebuilds vaultCryptState.profiles from the persisted settings, preserving
	 * the current lock/unlock state of profiles that are already open.
	 */
	private initRuntimeState(): void {
		this.mutateState(state => {
			state.profiles = Object.entries(this.settings.profiles).map(([id, cfg]) => {
				const existing = state.profiles.find(p => p.id === id);
				return {
					id,
					name: id,
					path: cfg.path,
					kdbxVersion: cfg.kdbxVersion,
					autoLockMinutes: cfg.autoLockMinutes,
					managedByKeyring: cfg.managedByKeyring,
					isLocked: existing ? existing.isLocked : !this.sessionService.isUnlocked(id),
					lastUnlock: existing?.lastUnlock ?? null,
				};
			});
			state.isLocked = state.profiles.every(p => p.isLocked);
			// currentProfile: keep if still present, otherwise null
			if (state.currentProfile) {
				const still = state.profiles.find(
					p => p.id === state.currentProfile!.id
				);
				state.currentProfile = still ?? null;
			}
		})

	}

	/** Returns true if the keyring is enabled and at least one managed profile is locked. */
	private shouldUseKeyringUnlock(): boolean {
		if (!this.settings.keyringEnabled) return false;
		return this.vaultCryptState.profiles.some(p => p.managedByKeyring && p.isLocked);
	}

	/** Updates the isLocked flag and lastUnlock date for a profile in runtime state. */
	private syncProfileLockState(profileId: string, isLocked: boolean): void {
		this.mutateState(state => {
			const profile = state.profiles.find(p => p.id === profileId);
			if (!profile) return;
			profile.isLocked = isLocked;
			if (!isLocked) profile.lastUnlock = new Date();
			// Keep the top-level isLocked in sync (true only when all profiles are locked)
			state.isLocked = state.profiles.every(p => p.isLocked);
		});
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

	/**
	 * Refreshes all chip decorations in both CM6 live-preview editors and
	 * reading-mode post-processed views.  Call after mutating KDBX data.
	 */
	public refreshChips(): void {
		this.refreshAllEditorChips();
		this.app.workspace.iterateAllLeaves(leaf => {
			if (leaf.view instanceof MarkdownView) {
				leaf.view.previewMode.rerender(true);
			}
		});
	}

	/**
	 * Dispatches `refreshChipsEffect` to all open CodeMirror editor views so
	 * that chip decorations are rebuilt immediately after a lock/unlock event.
	 */
	private refreshAllEditorChips(): void {
		this.app.workspace.iterateAllLeaves(leaf => {
			// Obsidian wraps the CodeMirror EditorView as editor.cm (semi-private)
			const cm: EditorView | undefined = leaf.view?.editor?.cm;
			if (!cm) {
				console.debug('[VaultCrypt] No CodeMirror editor found in leaf:', leaf);
				return;
			}
			cm.dispatch({effects: refreshChipsEffect.of(undefined)});
		});
	}

	patchSettings(patcher: (settings: VaultCryptSettings) => void) {
		const newSettings = structuredClone(peek(this._settings$));
		patcher(newSettings);

		this._settings$.set(newSettings);
	}

	private dispatchSaveSettings(settings: DeepReadonly<VaultCryptSettings>) {
		this.saveSettings(settings).then(() => {
			console.debug('[VaultCrypt] Settings saved successfully');
		}, (err) => {
			console.error('Error saving settings:', err);
			new Notice('Error saving settings. Please check the console for details.');
		});
	}

	scheduleClearClipboardTime(value: string, secs: number | undefined) {
		if (secs === undefined || secs <= 0) return;
		const timeoutId = window.setTimeout(() => {
			try {
				const ec = getElectronClipboard();
				if (ec) {
					if (ec.readText() === value) {
						ec.writeText('');
						console.debug('[VaultCrypt] Clipboard cleared (Electron)');
					}
				} else {
					navigator.clipboard.readText().then(current => {
						if (current === value) {
							navigator.clipboard.writeText('').then(
								() => console.debug('[VaultCrypt] Clipboard cleared'),
								() => new Notice('Failed to clear clipboard'),
							);
						}
					}).catch(() => {
						// readText may be denied; best-effort clear
						new Notice('Skipping clipboard clear because current contents could not be verified');
					});
				}
			} finally {
				this.clearClipboardTimeouts = this.clearClipboardTimeouts.filter(id => id !== timeoutId);
			}
		}, secs * 1000);
		this.clearClipboardTimeouts.push(timeoutId);
	}

	public mutateState(mutator: (state: VaultCryptState) => void) {
		const newState = structuredClone(peek(this._vaultCryptState$));
		mutator(newState);
		this._vaultCryptState$.set(newState);
	}
}
