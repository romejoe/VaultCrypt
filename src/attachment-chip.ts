import {Menu, Notice, Platform} from 'obsidian';
import {UnlockModal} from './modals';
import {ParsedVcToken} from './inline-parser';
import type VaultCryptPlugin from './main';
import {computed, effect, peek, signal, StopEffect} from '@maverick-js/signals';
import {html, render} from 'lit-html';
import {CHIP_DESTROY_EVENT} from './chip-component';

const ATTACHMENT_PREFIX = 'attachment:';

/** Sanitize a single path segment for safe use inside .vaultcrypt/attachments/. */
function sanitizeVaultSegment(value: string): string {
	if (!value) return '_';
	return value
		// eslint-disable-next-line no-control-regex
		.replace(/[\\/:*?"<>|\x00-\x1F]/g, '_')
		.replace(/^\.+$/, '_');
}

/** Extensions considered safe to decode as UTF-8 and copy to clipboard. */
const TEXT_EXTENSIONS = new Set([
	'.txt', '.md', '.pem', '.crt', '.cer', '.key', '.pub', '.csr',
	'.json', '.xml', '.csv', '.yaml', '.yml', '.toml', '.ini', '.conf',
	'.log', '.sh', '.env', '.p7b', '.p7c',
]);

function isTextAttachment(name: string): boolean {
	const dot = name.lastIndexOf('.');
	if (dot === -1) return false;
	return TEXT_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

/**
 * Builds a file chip for `{{vc:profileId/path#attachment:filename}}` tokens.
 *
 * State machine:
 *   unknown profile  →  error chip (static)
 *   profile locked   →  locked chip (click to unlock)
 *   profile unlocked →  ready chip (📎 filename [💾] [📋 text only]) or missing chip (⚠ not found)
 */
export function buildAttachmentChipElement(token: ParsedVcToken, plugin: VaultCryptPlugin): HTMLElement {
	const profileId = token.profileId.toLowerCase();
	const filename = token.fieldName!.slice(ATTACHMENT_PREFIX.length);
	const isText = isTextAttachment(filename);
	let effects: StopEffect[] = [];

	const profileConfig = computed(() => plugin.settings$().profiles[profileId]);
	const compact = computed(() => plugin.settings$().general.compactChips);

	const root = document.createElement('span');
	root.dataset.vcChip = '';
	root.dataset.vcCopyText = token.raw;
	root.title = `${profileId}/${token.entryPath}#${token.fieldName}`;

	const chipState = signal<'locked' | 'unknown' | 'ready' | 'missing'>('locked');
	const missingReason = signal<string>(`Attachment not found: ${filename}`);

	root.addEventListener(CHIP_DESTROY_EVENT, () => {
		for (const stop of effects) stop?.();
		effects = [];
	});

	root.addEventListener('contextmenu', (evt) => {
		evt.preventDefault();
		evt.stopPropagation();
		const menu = new Menu();
		menu.addItem(item => item
			.setTitle('Copy reference')
			.setIcon('copy')
			.onClick(() => {
				navigator.clipboard.writeText(token.raw).then(
					() => new Notice('Reference copied to clipboard'),
					() => new Notice('Failed to copy reference'),
				);
			}));
		menu.showAtMouseEvent(evt);
	});

	function resolveAttachmentState(): 'ready' | 'missing' {
		// Distinguish entry-not-found from attachment-not-found for a clearer error message.
		const entryFields = plugin.sessionService?.getEntryFields(profileId, token.entryPath);
		if (entryFields === null || entryFields === undefined) {
			missingReason.set(`Entry not found: ${token.entryPath}`);
			return 'missing';
		}
		const data = plugin.sessionService?.getAttachment(profileId, token.entryPath, filename);
		if (data === null || data === undefined) {
			missingReason.set(`Attachment not found: ${filename}`);
			return 'missing';
		}
		return 'ready';
	}

	function renderUnknown() {
		root.className = 'vaultcrypt-chip vaultcrypt-chip-error';
		render(html`⚠ unknown profile: ${token.profileId}`, root);
	}

	function renderLocked() {
		root.className = 'vaultcrypt-chip vaultcrypt-chip-locked';
		render(html`
			<button type="button" class="vaultcrypt-chip-btn" aria-label="Unlock ${profileId}"
				@click=${(evt: MouseEvent) => {
					evt.stopPropagation();
					new UnlockModal(plugin.app, plugin, profileId, () => {
						chipState.set(resolveAttachmentState());
					}).open();
				}}>${compact() ? '🔒 ••••••••' : `🔒 ${profileId}/${token.entryPath}#${token.fieldName}`}</button>
		`, root);
	}

	function renderReady() {
		root.className = 'vaultcrypt-chip vaultcrypt-chip-file';
		render(html`
			<span class="vaultcrypt-chip-icon">📎</span>
			<span class="vaultcrypt-chip-value">${filename}</span>
			<button type="button" class="vaultcrypt-chip-btn" title="Save attachment" aria-label="Save attachment ${filename}"
				@click=${(evt: MouseEvent) => {
					evt.stopPropagation();
					void saveAttachment();
				}}>💾</button>
			${isText
				? html`<button type="button" class="vaultcrypt-chip-btn" title="Copy to clipboard" aria-label="Copy ${filename} to clipboard"
					@click=${(evt: MouseEvent) => {
						evt.stopPropagation();
						copyAttachment();
					}}>📋</button>`
				: html`<button type="button" class="vaultcrypt-chip-btn" title="Binary file — use Save instead"
					aria-label="Binary file — use Save instead" disabled>📋</button>`}
		`, root);
	}

	function renderMissing() {
		root.className = 'vaultcrypt-chip vaultcrypt-chip-masked-error';
		render(html`
			<span class="vaultcrypt-chip-icon">⚠</span>
			<span>${missingReason()}</span>
		`, root);
	}

	async function saveAttachment(): Promise<void> {
		const data = plugin.sessionService?.getAttachment(profileId, token.entryPath, filename);
		if (!data) {
			new Notice('Could not read attachment — is the profile still unlocked?');
			return;
		}

		// Warn before saving large files.
		if (data.byteLength > 5 * 1024 * 1024) {
			const sizeMb = (data.byteLength / (1024 * 1024)).toFixed(1);
			if (!window.confirm(`This attachment is ${sizeMb} MB. Save it anyway?`)) return;
		}

		// Desktop: try Electron save dialog.
		if (Platform.isDesktop) {
			// Scope the try/catch to Electron discovery only so that a failed write
			// surfaces an explicit error rather than silently falling back to vault.
			// eslint-disable-next-line @typescript-eslint/no-explicit-any,@typescript-eslint/no-unsafe-assignment,@typescript-eslint/no-unsafe-member-access,@typescript-eslint/no-unsafe-call
			let dialog: {showSaveDialog(o: {defaultPath: string}): Promise<{canceled: boolean; filePath?: string}>} | undefined;
			try {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any,@typescript-eslint/no-unsafe-assignment,@typescript-eslint/no-unsafe-member-access,@typescript-eslint/no-unsafe-call
				dialog = (window as any).require?.('@electron/remote')?.dialog;
			} catch {
				dialog = undefined;
			}
			if (dialog) {
				const result = await dialog.showSaveDialog({defaultPath: filename});
				if (result.canceled || !result.filePath) return;
				try {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any,@typescript-eslint/no-unsafe-assignment,@typescript-eslint/no-unsafe-member-access,@typescript-eslint/no-unsafe-call
					const fs = (window as any).require?.('fs')?.promises;
					// eslint-disable-next-line @typescript-eslint/no-unsafe-call,@typescript-eslint/no-unsafe-member-access,no-undef
					await fs.writeFile(result.filePath, Buffer.from(data));
					new Notice(`Saved to ${result.filePath}`);
				} catch (err) {
					new Notice(`Failed to save: ${err instanceof Error ? err.message : String(err)}`);
				}
				return;
			}
		}

		// Mobile: try Web Share API.
		if (Platform.isMobile) {
			try {
				if (navigator.share) {
					const file = new File([data], filename, {type: 'application/octet-stream'});
					await navigator.share({files: [file]});
					return;
				}
			} catch (err) {
				// User cancelled share or share failed; fall through to vault save.
				if (err instanceof Error && err.name === 'AbortError') return;
			}
		}

		// Fallback: save into the vault's .vaultcrypt/attachments/ directory.
		try {
			const vcDir = plugin.settings$().general.vaultCryptDir;
			const safeProfileId = sanitizeVaultSegment(profileId);
			const safeEntry = token.entryPath.split('/').filter(Boolean).map(sanitizeVaultSegment).join('/');
			const safeFilename = sanitizeVaultSegment(filename);
			const dir = `${vcDir}/attachments/${safeProfileId}/${safeEntry}`;
			const savePath = `${dir}/${safeFilename}`;
			const adapter = plugin.app.vault.adapter;
			try {
				await adapter.mkdir(dir);
			} catch (e) {
				// Ignore "directory already exists"; propagate real errors (permissions, disk full, etc.)
				if (!(e instanceof Error && e.message.includes('EEXIST'))) throw e;
			}
			await adapter.writeBinary(savePath, data);
			new Notice(`Saved to vault: ${savePath}`);
		} catch (err) {
			new Notice(`Failed to save: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	function copyAttachment(): void {
		const data = plugin.sessionService?.getAttachment(profileId, token.entryPath, filename);
		if (!data) {
			new Notice('Could not read attachment — is the profile still unlocked?');
			return;
		}
		let text: string;
		try {
			text = new TextDecoder('utf-8', {fatal: true}).decode(data);
		} catch {
			new Notice('Attachment does not appear to be valid UTF-8 text — use 💾 to save instead.');
			return;
		}
		const secs = plugin.settings$().security.clipboardClearSeconds;
		navigator.clipboard.writeText(text).then(() => {
			const msg = secs > 0 ? `Copied to clipboard (clears in ${secs}s)` : 'Copied to clipboard';
			new Notice(msg, 3000);
			if (secs > 0) plugin.scheduleClearClipboardTime(text, secs);
		}).catch(() => new Notice('Failed to copy to clipboard'));
	}

	effects = [
		effect(() => {
			const config = profileConfig();
			if (!config) {
				chipState.set('unknown');
				return;
			}
			const profileLocked = plugin.vaultCryptState$().profiles.find(p => p.id === profileId)?.isLocked ?? true;
			if (profileLocked) {
				chipState.set('locked');
				return;
			}
			if (peek(chipState) === 'locked' || peek(chipState) === 'unknown') {
				chipState.set(resolveAttachmentState());
			}
		}),

		effect(() => {
			const state = chipState();
			if (state === 'unknown') renderUnknown();
			else if (state === 'locked') renderLocked();
			else if (state === 'ready') renderReady();
			else if (state === 'missing') renderMissing();
		}),
	];

	return root;
}
