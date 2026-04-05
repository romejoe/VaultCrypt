import {Menu, Notice, Platform, TFile} from 'obsidian';
import {UnlockModal} from './modals';
import {ParsedVcToken} from './inline-parser';
import type VaultCryptPlugin from './main';
import {computed, effect, peek, signal, StopEffect} from '@maverick-js/signals';
import {html, render, nothing} from 'lit-html';
import {unsafeHTML} from 'lit-html/directives/unsafe-html.js';
import {CHIP_DESTROY_EVENT} from './chip-component';

export const ATTACHMENT_PREFIX = 'attachment:';

const MAX_PREVIEW_BYTES = 10 * 1024; // 10 KB

/** Sanitize a single path segment for safe use inside .vaultcrypt/attachments/. */
function sanitizeVaultSegment(value: string): string {
	if (!value) return '_';
	return value
		// eslint-disable-next-line no-control-regex -- control characters (0x00–0x1F) must be stripped from filesystem paths
		.replace(/[\\/:*?"<>|\x00-\x1F]/g, '_')
		.replace(/^\.+$/, '_');
}

/** Extensions considered safe to decode as UTF-8 and copy to clipboard. */
const TEXT_EXTENSIONS = new Set([
	'.txt', '.md', '.pem', '.crt', '.cer', '.key', '.pub', '.csr',
	'.json', '.xml', '.csv', '.yaml', '.yml', '.toml', '.ini', '.conf',
	'.log', '.sh', '.env', '.p7b', '.p7c', '.html', '.css',
]);

const IMAGE_MIME_TYPES: Record<string, string> = {
	'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
	'.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp',
	'.svg': 'image/svg+xml',
};

const VIDEO_MIME_TYPES: Record<string, string> = {
	'.mp4': 'video/mp4', '.webm': 'video/webm',
	'.ogg': 'video/ogg', '.mov': 'video/quicktime',
};

/**
 * File extension → Prism language token.
 * Subset that is reliably bundled with Obsidian's Prism instance.
 */
const PRISM_LANG_MAP: Record<string, string> = {
	'.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
	'.xml': 'xml', '.sh': 'bash', '.md': 'markdown',
	'.html': 'html', '.css': 'css',
	'.toml': 'toml', '.ini': 'ini', '.conf': 'ini',
};

/** Duck-typed access to Obsidian's bundled Prism instance. */
type PrismLike = {
	highlight(text: string, grammar: object, lang: string): string;
	languages: Record<string, object | undefined>;
};

function getExt(name: string): string {
	const dot = name.lastIndexOf('.');
	return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

function isTextAttachment(name: string): boolean {
	return TEXT_EXTENSIONS.has(getExt(name));
}

function isImageAttachment(name: string): boolean {
	return getExt(name) in IMAGE_MIME_TYPES;
}

function isVideoAttachment(name: string): boolean {
	return getExt(name) in VIDEO_MIME_TYPES;
}

function prismLang(name: string): string | null {
	return PRISM_LANG_MAP[getExt(name)] ?? null;
}

function getGlobalPrism(): PrismLike | undefined {
	return (window as unknown as { Prism?: PrismLike }).Prism;
}

// ── Video element cache ──────────────────────────────────────────────────────
// Preserves live <video> DOM elements (and their currentTime / play state)
// across CodeMirror viewport-virtualisation cycles.  When a chip scrolls out
// of view CM destroys the widget; when it scrolls back in a new widget is
// created.  By stashing the <video> element here and re-inserting it we keep
// playback uninterrupted.  Keyed by "profileId::entryPath::filename".

interface VideoCacheEntry {
	videoEl: HTMLVideoElement;
	objectUrl: string;
}

const VIDEO_ELEMENT_CACHE = new Map<string, VideoCacheEntry>();

/**
 * Revokes all cached video blob URLs for the given profile (or all profiles
 * when called without an argument).  Must be called on profile lock and plugin
 * unload so that media data is not accessible after the session ends.
 */
export function revokeAttachmentVideoCache(profileId?: string): void {
	for (const [key, entry] of VIDEO_ELEMENT_CACHE) {
		if (!profileId || key.startsWith(`${profileId}::`)) {
			URL.revokeObjectURL(entry.objectUrl);
			VIDEO_ELEMENT_CACHE.delete(key);
		}
	}
}

/**
 * Builds a file chip for `{{vc:profileId/path#attachment:filename}}` tokens.
 *
 * State machine:
 *   unknown profile  →  error chip (static)
 *   profile locked   →  locked chip (click to unlock)
 *   profile unlocked →  masked chip (📎 ••••••••, click to reveal)
 *                    ⟷  revealed chip (📎 filename [💾] [📋] [▶/▼])
 *                        ↳  preview expanded (text / image / video inline)
 *                        ↳  missing chip (⚠ reason) when entry/file not found
 */
export function buildAttachmentChipElement(token: ParsedVcToken, plugin: VaultCryptPlugin): HTMLElement {
	const profileId = token.profileId.toLowerCase();
	const filename = token.fieldName!.slice(ATTACHMENT_PREFIX.length);
	const isText = isTextAttachment(filename);
	const isImage = isImageAttachment(filename);
	const isVideo = isVideoAttachment(filename);
	const canPreview = isText || isImage || isVideo;

	const cacheKey = `${profileId}::${token.entryPath}::${filename}`;

	// Restore from video element cache if the chip was previously visible with
	// the preview open (i.e. it scrolled out while playing).
	const restoredEntry = isVideo ? VIDEO_ELEMENT_CACHE.get(cacheKey) : undefined;
	if (restoredEntry) VIDEO_ELEMENT_CACHE.delete(cacheKey);

	let effects: StopEffect[] = [];
	let previewObjectUrl: string | null = restoredEntry?.objectUrl ?? null;
	// The live <video> element extracted from the previous chip instance.
	let cachedVideoEl: HTMLVideoElement | null = restoredEntry?.videoEl ?? null;

	const profileConfig = computed(() => plugin.settings$().profiles[profileId]);
	const compact = computed(() => plugin.settings$().general.compactChips);

	const chipState = signal<'locked' | 'unknown' | 'ready' | 'missing'>('locked');
	const missingReason = signal<string>(`Attachment not found: ${filename}`);
	// Whether the filename and action buttons are visible (vs. showing dots).
	const attachmentRevealed = signal(restoredEntry !== undefined);
	// Whether the inline preview is expanded.
	const previewOpen = signal(restoredEntry !== undefined);

	const root = document.createElement('span');
	root.dataset.vcChip = '';
	root.dataset.vcCopyText = token.raw;
	root.title = `${profileId}/${token.entryPath}#${token.fieldName}`;

	function revokePreviewUrl() {
		if (previewObjectUrl) {
			URL.revokeObjectURL(previewObjectUrl);
			previewObjectUrl = null;
		}
		cachedVideoEl = null;
	}

	root.addEventListener(CHIP_DESTROY_EVENT, () => {
		for (const stop of effects) stop?.();
		effects = [];

		// If a video preview is open, stash the live <video> element so that
		// playback can resume when the chip scrolls back into view.
		if (isVideo && previewObjectUrl && peek(previewOpen)) {
			const videoEl = root.querySelector('video');
			if (videoEl) {
				// Revoke any previously cached entry for this key (e.g. a second
				// chip instance for the same token) before overwriting.
				const displaced = VIDEO_ELEMENT_CACHE.get(cacheKey);
				if (displaced) URL.revokeObjectURL(displaced.objectUrl);
				videoEl.remove(); // detach from chip DOM so old subtree can be GC'd
				VIDEO_ELEMENT_CACHE.set(cacheKey, {videoEl, objectUrl: previewObjectUrl});
				previewObjectUrl = null; // ownership transferred to cache
				return;
			}
		}
		revokePreviewUrl();
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

	function togglePreview() {
		if (peek(previewOpen)) {
			revokePreviewUrl();
			previewOpen.set(false);
		} else {
			previewOpen.set(true);
		}
	}

	function buildTextPreview() {
		const data = plugin.sessionService?.getAttachment(profileId, token.entryPath, filename);
		if (!data) {
			return html`<div class="vaultcrypt-preview-error">Attachment not available.</div>`;
		}
		const isLarge = data.byteLength > MAX_PREVIEW_BYTES;
		const cap = isLarge ? MAX_PREVIEW_BYTES : data.byteLength;
		let text: string | null = null;
		if (isLarge) {
			// Back off up to 3 bytes so we never cut a multi-byte UTF-8 sequence
			// at the truncation boundary.
			for (let trim = 0; trim <= 3; trim++) {
				try {
					text = new TextDecoder('utf-8', {fatal: true}).decode(data.slice(0, cap - trim));
					break;
				} catch {
					// try shorter slice
				}
			}
		} else {
			// Full content — single decode attempt; no boundary splitting possible.
			try {
				text = new TextDecoder('utf-8', {fatal: true}).decode(data.slice(0, cap));
			} catch {
				// not valid UTF-8
			}
		}
		if (text === null) {
			return html`<div class="vaultcrypt-preview-error">Cannot display: not valid UTF-8.</div>`;
		}
		const lang = prismLang(filename);
		const prism = getGlobalPrism();
		const grammar = lang ? prism?.languages[lang] : undefined;
		return html`
			<div class="vaultcrypt-attachment-preview">
				<pre class="vaultcrypt-preview-code"><code class=${lang ? `language-${lang}` : nothing}>${
					grammar && prism && lang
						? unsafeHTML(prism.highlight(text, grammar, lang))
						: text
				}</code></pre>
				${isLarge
					? html`<p class="vaultcrypt-preview-truncated">… (truncated — ${Math.round(data.byteLength / 1024)} KB total)</p>`
					: nothing}
			</div>
		`;
	}

	function buildMediaPreview(type: 'image' | 'video') {
		const data = plugin.sessionService?.getAttachment(profileId, token.entryPath, filename);
		if (!data) {
			return html`<div class="vaultcrypt-preview-error">Attachment not available.</div>`;
		}
		const ext = getExt(filename);
		const mime = type === 'image'
			? (IMAGE_MIME_TYPES[ext] ?? 'image/png')
			: (VIDEO_MIME_TYPES[ext] ?? 'video/mp4');

		if (type === 'video' && cachedVideoEl) {
			// Re-insert the same <video> DOM node — browser preserves currentTime
			// and play/pause state when a node is removed then reinserted.
			const el = cachedVideoEl;
			cachedVideoEl = null; // consume; previewObjectUrl already set
			return html`<div class="vaultcrypt-attachment-preview">${el}</div>`;
		}

		if (!previewObjectUrl) {
			previewObjectUrl = URL.createObjectURL(new Blob([data], {type: mime}));
		}
		return type === 'image'
			? html`<div class="vaultcrypt-attachment-preview"><img src="${previewObjectUrl}" alt="${filename}" class="vaultcrypt-preview-image"></div>`
			: html`<div class="vaultcrypt-attachment-preview"><video src="${previewObjectUrl}" controls class="vaultcrypt-preview-video"></video></div>`;
	}

	function renderUnknown() {
		root.className = 'vaultcrypt-chip vaultcrypt-chip-error';
		render(html`⚠ unknown profile: ${token.profileId}`, root);
	}

	function renderLocked() {
		root.className = 'vaultcrypt-chip vaultcrypt-chip-locked';
		const openUnlock = (evt: Event) => {
			evt.stopPropagation();
			new UnlockModal(plugin.app, plugin, profileId, () => {
				chipState.set(resolveAttachmentState());
			}).open();
		};
		render(html`
			<span role="button" tabindex="0" aria-label="Unlock ${profileId}"
			      @click=${openUnlock}
			      @keydown=${(evt: KeyboardEvent) => { if (evt.key === 'Enter' || evt.key === ' ') { evt.preventDefault(); openUnlock(evt); } }}
			>${compact() ? '🔒 ••••••••' : `🔒 ${profileId}/${token.entryPath}#${token.fieldName}`}</span>
		`, root);
	}

	function renderReady() {
		const isOpen = previewOpen();
		const isRevealed = attachmentRevealed();

		if (!isRevealed) {
			// Masked — mirrors the regular chip's masked state exactly
			root.className = 'vaultcrypt-chip vaultcrypt-chip-masked';
			const onReveal = (evt: Event) => {
				evt.stopPropagation();
				attachmentRevealed.set(true);
				if (canPreview && plugin.settings$().general.autoPreviewAttachments) {
					previewOpen.set(true);
				}
			};
			const onRevealKey = (evt: KeyboardEvent) => { if (evt.key === 'Enter' || evt.key === ' ') { evt.preventDefault(); onReveal(evt); } };
			render(html`
				<span class="vaultcrypt-chip-icon vaultcrypt-chip-icon-locked"
				      role="button" tabindex="0" aria-label="Reveal attachment"
				      @click=${onReveal} @keydown=${onRevealKey}>🔒</span>
				<span class="vaultcrypt-chip-dots"
				      role="button" tabindex="0" aria-label="Reveal attachment"
				      @click=${onReveal} @keydown=${onRevealKey}>••••••••</span>
				${isText ? html`
					<button class="vaultcrypt-chip-btn" title="Copy to clipboard"
					        @mousedown=${(evt: MouseEvent) => {
								evt.preventDefault();
								evt.stopPropagation();
							}}
					        @click=${(evt: MouseEvent) => {
								evt.stopPropagation();
								copyAttachment();
							}}>📋</button>
				` : nothing}
			`, root);
			return;
		}

		root.className = `vaultcrypt-chip vaultcrypt-chip-file${isOpen ? ' vaultcrypt-chip-expanded' : ''}`;

		// Revealed state — show filename and action buttons
		render(html`
			<span class="vaultcrypt-chip-file-row">
				<span class="vaultcrypt-chip-icon" title="Mask attachment"
				      role="button" tabindex="0" aria-label="Mask attachment" style="cursor:pointer"
				      @click=${(evt: Event) => {
						evt.stopPropagation();
						if (isOpen) { revokePreviewUrl(); previewOpen.set(false); }
						attachmentRevealed.set(false);
					}}
				      @keydown=${(evt: KeyboardEvent) => {
						if (evt.key === 'Enter' || evt.key === ' ') {
							evt.preventDefault();
							evt.stopPropagation();
							if (isOpen) { revokePreviewUrl(); previewOpen.set(false); }
							attachmentRevealed.set(false);
						}
					}}>📎</span>
				<span class="vaultcrypt-chip-value">${filename}</span>
				<button type="button" class="vaultcrypt-chip-btn" title="Save attachment"
				        aria-label="Save attachment ${filename}"
				        @click=${(evt: MouseEvent) => {
							evt.stopPropagation();
							void saveAttachment();
						}}>💾
				</button>
				${isText
					? html`
						<button type="button" class="vaultcrypt-chip-btn" title="Copy to clipboard"
						        aria-label="Copy ${filename} to clipboard"
						        @click=${(evt: MouseEvent) => {
									evt.stopPropagation();
									copyAttachment();
								}}>📋
						</button>`
					: html`
						<button type="button" class="vaultcrypt-chip-btn" title="Binary file — use Save instead"
						        aria-label="Binary file — use Save instead" disabled>📋
						</button>`}
				${canPreview
					? html`
						<button type="button" class="vaultcrypt-chip-btn vaultcrypt-chip-expand-btn"
						        title="${isOpen ? 'Collapse preview' : 'Expand preview'}"
						        aria-label="${isOpen ? 'Collapse preview' : 'Expand preview'}"
						        @click=${(evt: MouseEvent) => {
									evt.stopPropagation();
									togglePreview();
								}}>${isOpen ? '▼' : '▶'}
						</button>`
					: nothing}
			</span>
			${isOpen
				? (isText
					? buildTextPreview()
					: isImage
						? buildMediaPreview('image')
						: buildMediaPreview('video'))
				: nothing}
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

		// Desktop: try Electron save dialog.
		if (Platform.isDesktop) {
			type ElectronDialog = { showSaveDialog(o: { defaultPath: string }): Promise<{ canceled: boolean; filePath?: string }> };
			type RemoteModule = { dialog?: ElectronDialog };
			type FsPromises = { writeFile(path: string, data: Uint8Array): Promise<void> };
			type FsModule = { promises?: FsPromises };
			let dialog: ElectronDialog | undefined;
			try {
				dialog = (window as unknown as { require?: (id: string) => RemoteModule }).require?.('@electron/remote')?.dialog;
			} catch {
				dialog = undefined;
			}
			if (dialog) {
				let result: { canceled: boolean; filePath?: string };
				try {
					result = await dialog.showSaveDialog({defaultPath: filename});
				} catch (err) {
					new Notice(`Failed to open save dialog: ${err instanceof Error ? err.message : String(err)}`);
					return;
				}
				if (result.canceled || !result.filePath) return;
				try {
					const fs = (window as unknown as { require?: (id: string) => FsModule }).require?.('fs')?.promises;
					// eslint-disable-next-line no-undef -- Buffer is a Node.js global available in Electron
					await fs?.writeFile(result.filePath, Buffer.from(data));
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
				const file = new File([data], filename, {type: 'application/octet-stream'});
				if (navigator.canShare?.({files: [file]})) {
					await navigator.share({files: [file]});
					return;
				}
			} catch (err) {
				if (err instanceof Error && err.name === 'AbortError') return;
			}
		}

		// Fallback: save into the vault's .vaultcrypt/attachments/ directory.
		try {
			const vault = plugin.app.vault;
			const vcDir = plugin.settings$().general.vaultCryptDir;
			const safeProfileId = sanitizeVaultSegment(profileId);
			const safeEntry = token.entryPath.split('/').filter(Boolean).map(sanitizeVaultSegment).join('/');
			const safeFilename = sanitizeVaultSegment(filename);
			const dir = `${vcDir}/attachments/${safeProfileId}/${safeEntry}`;
			const savePath = `${dir}/${safeFilename}`;
			// vault.createFolder() is not recursive — create each path segment in order
			const segments = dir.split('/');
			for (let i = 1; i <= segments.length; i++) {
				const partial = segments.slice(0, i).join('/');
				if (!vault.getAbstractFileByPath(partial)) {
					await vault.createFolder(partial);
				}
			}
			const existingFile = vault.getAbstractFileByPath(savePath);
			if (existingFile instanceof TFile) {
				await vault.modifyBinary(existingFile, data);
			} else {
				await vault.createBinary(savePath, data);
			}
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
				// Close preview and mask on lock so stale data is not shown.
				if (peek(previewOpen)) {
					revokePreviewUrl();
					previewOpen.set(false);
				}
				attachmentRevealed.set(false);
				chipState.set('locked');
				return;
			}
			if (peek(chipState) === 'locked' || peek(chipState) === 'unknown') {
				const newState = resolveAttachmentState();
				if (newState === 'ready') {
					const generalSettings = plugin.settings$().general;
					if (canPreview && generalSettings.autoPreviewAttachments) {
						attachmentRevealed.set(true);
						previewOpen.set(true);
					} else if (generalSettings.autoUnmask) {
						attachmentRevealed.set(true);
					}
				}
				chipState.set(newState);
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
