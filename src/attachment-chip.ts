import {Menu, Notice} from 'obsidian';
import {UnlockModal} from './modals';
import {ParsedVcToken} from './inline-parser';
import type VaultCryptPlugin from './main';
import {computed, effect, peek, signal, StopEffect} from '@maverick-js/signals';
import {html, render} from 'lit-html';
import {CHIP_DESTROY_EVENT} from './chip-component';

const ATTACHMENT_PREFIX = 'attachment:';

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
	root.title = `${profileId}/${token.entryPath}#${token.fieldName}`;

	const chipState = signal<'locked' | 'unknown' | 'ready' | 'missing'>('locked');

	root.addEventListener(CHIP_DESTROY_EVENT, () => {
		for (const stop of effects) stop?.();
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
		const data = plugin.sessionService?.getAttachment(profileId, token.entryPath, filename);
		return (data !== null && data !== undefined) ? 'ready' : 'missing';
	}

	function renderUnknown() {
		root.className = 'vaultcrypt-chip vaultcrypt-chip-error';
		render(html`⚠ unknown profile: ${token.profileId}`, root);
	}

	function renderLocked() {
		root.className = 'vaultcrypt-chip vaultcrypt-chip-locked';
		render(html`
			<span @click=${(evt: MouseEvent) => {
				evt.stopPropagation();
				new UnlockModal(plugin.app, plugin, profileId, () => {
					chipState.set(resolveAttachmentState());
				}).open();
			}}>${compact() ? '🔒 ••••••••' : `🔒 ${profileId}/${token.entryPath}#${token.fieldName}`}</span>
		`, root);
	}

	function renderReady() {
		root.className = 'vaultcrypt-chip vaultcrypt-chip-file';
		render(html`
			<span class="vaultcrypt-chip-icon">📎</span>
			<span class="vaultcrypt-chip-value">${filename}</span>
			<button class="vaultcrypt-chip-btn" title="Save to vault"
				@click=${(evt: MouseEvent) => {
					evt.stopPropagation();
					void saveAttachment();
				}}>💾</button>
			${isText ? html`
				<button class="vaultcrypt-chip-btn" title="Copy to clipboard"
					@click=${(evt: MouseEvent) => {
						evt.stopPropagation();
						copyAttachment();
					}}>📋</button>
			` : null}
		`, root);
	}

	function renderMissing() {
		root.className = 'vaultcrypt-chip vaultcrypt-chip-masked-error';
		render(html`
			<span class="vaultcrypt-chip-icon">⚠</span>
			<span>Attachment not found: ${filename}</span>
		`, root);
	}

	async function saveAttachment(): Promise<void> {
		const data = plugin.sessionService?.getAttachment(profileId, token.entryPath, filename);
		if (!data) {
			new Notice('Could not read attachment — is the profile still unlocked?');
			return;
		}
		try {
			const sanitizedEntry = token.entryPath.replace(/[<>:"|?*]/g, '_');
			const dir = `.vaultcrypt/attachments/${profileId}/${sanitizedEntry}`;
			const savePath = `${dir}/${filename}`;
			const adapter = plugin.app.vault.adapter;
			try { await adapter.mkdir(dir); } catch { /* already exists */ }
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
		const secs = plugin.settings.security.clipboardClearSeconds;
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
