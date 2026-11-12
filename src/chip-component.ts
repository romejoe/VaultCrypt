import {Menu, Notice, Platform} from 'obsidian';
import {UnlockModal, EditSecretModal, DeleteSecretModal} from './modals';
import {ParsedVcToken, resolveFieldName} from './inline-parser';
import type VaultCryptPlugin from './main';
import {computed, effect, peek, signal, StopEffect} from "@maverick-js/signals";
import {html, render, nothing} from 'lit-html';
import {ref, createRef} from 'lit-html/directives/ref.js';
import {buildAttachmentChipElement, ATTACHMENT_PREFIX} from './attachment-chip';

export const CHIP_DESTROY_EVENT = 'vaultcrypt-destroy';

/** Editing sub-state: mode + in-progress value, or null when not editing. */
interface EditState {
	mode: 'inline' | 'multiline';
	value: string;
}

/**
 * Builds an interactive inline chip element for a parsed {{vc:...}} token.
 *
 * A single root <span> is created and its children are mutated in-place
 * whenever state changes (locked → masked → revealed → editing → masked …).
 * This is critical for the CodeMirror live-preview mode, which owns the root
 * element and would discard any element that replaces it via replaceWith().
 *
 * State machine:
 *   unknown profile  →  error chip (static)
 *   profile locked   →  locked chip (click to unlock)
 *   profile unlocked →  masked chip (copy) ⟷ revealed chip (show value, edit, copy)
 *                                                ⟷ editing chip (inline input / popover)
 *                        ↓ on getFieldValue null
 *                       masked-error chip (verbose reason, retry button)
 */
/**
 * Dispatcher: routes to the attachment chip or the secret-value chip based on the token's field name.
 */
export function buildChipElement(token: ParsedVcToken, plugin: VaultCryptPlugin): HTMLElement {
	if (token.fieldName?.startsWith(ATTACHMENT_PREFIX)) {
		return buildAttachmentChipElement(token, plugin);
	}
	return buildSecretChipElement(token, plugin);
}

function buildSecretChipElement(token: ParsedVcToken, plugin: VaultCryptPlugin): HTMLElement {
	const profileId = token.profileId.toLowerCase();
	let effects: StopEffect[] = [];
	const profileConfig = computed(() => {
		return plugin.settings$().profiles[profileId];
	});

	const compact = computed(() => {
		return plugin.settings$().general.compactChips;
	});

	const autoUnmask = computed(() => {
		return plugin.settings$().general.autoUnmask;
	});

	const saveOnBlur = computed(() => {
		return plugin.settings$().general.saveOnBlur;
	});

	const root = document.createElement('span');
	root.dataset.vcChip = '';
	const chipState = signal<'locked' | 'masked' | 'revealed' | 'unknown' | 'masked-error'>('locked');
	const errorReason = signal<string>('');
	const justSaved = signal(false);

	/**
	 * Editing sub-state signal. null = not editing. When non-null, holds the
	 * current editor mode and the in-progress value so that switching between
	 * inline ↔ multiline preserves the user's text.
	 */
	const editState = signal<EditState | null>(null);

	// Reference to an active multi-line popover for cleanup
	let activePopover: HTMLElement | null = null;

	const field = computed(() => {
		const config = profileConfig();
		return resolveFieldName(token, config?.defaultField ?? 'Password');
	});

	const tooltipPath = computed(() => {
		return `${profileId}/${token.entryPath}#${field()}`;
	});

	let cleanupPopover = () => {
		if (activePopover) {
			activePopover.remove();
			activePopover = null;
		}
	};

	root.addEventListener(CHIP_DESTROY_EVENT, () => {
		cleanupPopover();
		for (const effect of effects) {
			effect?.();
		}
	});

	// ── Context menu (right-click) ──────────────────────────────────────────
	root.addEventListener('contextmenu', (evt) => {
		evt.preventDefault();
		evt.stopPropagation();

		const menu = new Menu();
		const unlocked = plugin.sessionService?.isUnlocked(profileId);

		if (unlocked) {
			menu.addItem(item => item
				.setTitle('Edit entry')
				.setIcon('pencil')
				.onClick(() => {
					new EditSecretModal(plugin.app, plugin, profileId, token.entryPath, token).open();
				}));

			menu.addItem(item => item
				.setTitle('Delete entry')
				.setIcon('trash-2')
				.onClick(() => {
					new DeleteSecretModal(plugin.app, plugin, profileId, token.entryPath).open();
				}));

			menu.addSeparator();
		}

		menu.addItem(item => item
			.setTitle('Copy reference')
			.setIcon('copy')
			.onClick(() => {
				navigator.clipboard.writeText(token.raw).then(
					() => new Notice('Reference copied to clipboard'),
					() => new Notice('Failed to copy reference'),
				);
			}));

		if (Platform.isDesktop) {
			menu.addItem(item => item
				.setTitle('Open database file')
				.setIcon('external-link')
				.onClick(async () => {
					const config = peek(profileConfig);
					if (!config) {
						new Notice('Profile configuration not found');
						return;
					}
					try {
						type ElectronShell = { openPath: (path: string) => Promise<string> };
						type ElectronModule = { shell?: ElectronShell };
						const shell = (window as unknown as { require?: (id: string) => ElectronModule }).require?.('electron')?.shell;
						const adapter = plugin.app.vault.adapter as { getFullPath?: (path: string) => string };
						if (shell && adapter.getFullPath) {
							const errorMsg = await shell.openPath(adapter.getFullPath(config.path));
							if (errorMsg) {
								new Notice(`Failed to open file: ${errorMsg}`);
							}
						} else {
							new Notice('Cannot determine full file path');
						}
					} catch {
						new Notice('Failed to open file');
					}
				}));
		}

		menu.showAtMouseEvent(evt);
	});

	/** Enter editing mode — reads the current db value (or empty string) and auto-detects mode. */
	function startEditing() {
		if (!plugin.sessionService?.isUnlocked(profileId)) {
			new Notice('Profile is locked — cannot edit.');
			return;
		}
		const value = plugin.sessionService?.getFieldValue(profileId, token.entryPath, peek(field)) ?? '';
		const isMultiline = value.includes('\n') || peek(field).toLowerCase() === 'notes';
		editState.set({mode: isMultiline ? 'multiline' : 'inline', value});
	}

	effects = [
		effect(() => {
			root.title = tooltipPath();
		}),

		effect(() => {
			const currentState = chipState();
			const pluginState = plugin.vaultCryptState$();
			const config = profileConfig();

			if(!config) {
				chipState.set('unknown');
				return;
			}

			const profileLocked = pluginState.profiles.find(profile => {
				return profile.id === profileId;
			})?.isLocked ?? true;

			if (profileLocked) {
				// Cancel editing if profile locks
				if (peek(editState) !== null) {
					editState.set(null);
					cleanupPopover();
				}
				chipState.set('locked');
				return;
			}

			if (currentState === 'unknown' || currentState === 'revealed' || currentState === 'masked-error') {
				return;
			}

			if (currentState === 'locked') {
				chipState.set(peek(autoUnmask) ? 'revealed' : 'masked');
			}
		}),

		effect(() => {
			const currentState = chipState();
			if (currentState === 'unknown') {
				renderUnknown();
			}
			if (currentState === 'locked') {
				renderLocked();
			} else if (currentState === 'masked') {
				renderMasked();
			} else if (currentState === 'revealed') {
				// Skip re-render if we're in editing mode
				if (peek(editState) !== null) return;
				const value = plugin.sessionService?.getFieldValue(profileId, token.entryPath, field());
				if (value === null || value === undefined) {
					errorReason.set(`Entry or field not found: ${peek(tooltipPath)}`);
					chipState.set('masked-error');
					renderMaskedError(peek(errorReason));

				} else {
					renderRevealed(value);
				}
			} else if (currentState === 'masked-error') {
				renderMaskedError(peek(errorReason));
			}
		}),

		// ── Editing effect — watches editState signal ──────────────────────
		effect(() => {
			const es = editState();
			if (es !== null) {
				if (es.mode === 'multiline') {
					renderEditingMultiline(es.value);
				} else {
					renderEditingInline(es.value);
				}
			} else {
				cleanupPopover();
				// Re-render after editing ends — transition to revealed if a value now exists
				const currentState = peek(chipState);
				if (currentState === 'revealed' || currentState === 'masked-error') {
					const value = plugin.sessionService?.getFieldValue(profileId, token.entryPath, peek(field));
					if (value !== null && value !== undefined) {
						chipState.set('revealed');
						renderRevealed(value);
					} else if (currentState === 'masked-error') {
						renderMaskedError(peek(errorReason));
					}
				}
			}
		}),
	];

	// ── Inner render functions — each renders a lit-html template into root ──

	function renderUnknown() {
		if (!peek(profileConfig)) {
			root.className = 'vaultcrypt-chip vaultcrypt-chip-error';
			root.dataset.vcCopyText = '[unknown]';
			render(html`⚠ unknown profile: ${token.profileId}`, root);
		}
	}

	function renderLocked() {
		root.className = 'vaultcrypt-chip vaultcrypt-chip-locked';
		root.dataset.vcCopyText = '[locked]';
		render(html`
			<span @click=${(evt: MouseEvent) => {
				evt.stopPropagation();
				new UnlockModal(plugin.app, plugin, profileId, () => {
					chipState.set('masked');
				}).open();
			}}>${compact() ? '🔒 ••••••••' : `🔒 ${tooltipPath()}`}</span>
		`, root);
	}

	function renderMasked() {
		root.className = 'vaultcrypt-chip vaultcrypt-chip-masked';
		root.dataset.vcCopyText = '[encrypted]';
		const onReveal = (evt: MouseEvent) => {
			evt.stopPropagation();
			chipState.set('revealed');
		};
		render(html`
			<span class="vaultcrypt-chip-icon vaultcrypt-chip-icon-locked"
				@click=${onReveal}>🔒</span>
			<span class="vaultcrypt-chip-dots"
				@click=${onReveal}>••••••••</span>
			<button class="vaultcrypt-chip-btn" title="Copy to clipboard"
				@mousedown=${(evt: MouseEvent) => {
					evt.preventDefault();
					evt.stopPropagation();
				}}
				@click=${(evt: MouseEvent) => {
					evt.stopPropagation();
					copyField(profileId, token.entryPath, peek(field), plugin);
				}}>📋</button>
		`, root);
	}

	function renderMaskedError(reason: string) {
		root.className = 'vaultcrypt-chip vaultcrypt-chip-masked-error';
		root.dataset.vcCopyText = '[encrypted]';
		render(html`
			<span class="vaultcrypt-chip-icon">⚠</span>
			<span>${reason}</span>
			${!compact() ? html`
				<button class="vaultcrypt-chip-btn" title="Create and edit"
					@click=${(evt: MouseEvent) => {
						evt.stopPropagation();
						startEditing();
					}}>✏️</button>
			` : nothing}
			<button class="vaultcrypt-chip-btn" title="Retry"
				@click=${(evt: MouseEvent) => {
					evt.stopPropagation();
					chipState.set('masked');
				}}>🔄</button>
		`, root);
	}

	function renderRevealed(value: string) {
		root.className = 'vaultcrypt-chip vaultcrypt-chip-revealed';
		root.dataset.vcCopyText = value;

		const MAX_DISPLAY = 40;
		const firstNonEmpty = value.split('\n').find(l => l.trim() !== '') ?? '';
		let display = firstNonEmpty.slice(0, MAX_DISPLAY);
		const isTruncated = display.length < value.length || value.includes('\n');
		if (isTruncated) display += '…';

		const showSaved = peek(justSaved);
		if (showSaved) justSaved.set(false);

		const editBtnRef = createRef<HTMLButtonElement>();

		render(html`
			<span class="vaultcrypt-chip-icon vaultcrypt-chip-icon-unlocked"
				title="Click to mask"
				@click=${(evt: MouseEvent) => {
					evt.stopPropagation();
					chipState.set('masked');
				}}>🔓</span>
			<span class="vaultcrypt-chip-value"
				title=${isTruncated ? value : nothing}>${display}</span>
			${!compact() ? html`
				<button ${ref(editBtnRef)}
					class=${showSaved ? 'vaultcrypt-chip-btn vaultcrypt-chip-btn-saved' : 'vaultcrypt-chip-btn'}
					title="Edit"
					@click=${(evt: MouseEvent) => {
						evt.stopPropagation();
						startEditing();
					}}>${showSaved ? '✅' : '✏️'}</button>
			` : nothing}
			<button class="vaultcrypt-chip-btn" title="Copy to clipboard"
				@mousedown=${(evt: MouseEvent) => {
					evt.preventDefault();
					evt.stopPropagation();
				}}
				@click=${(evt: MouseEvent) => {
					evt.stopPropagation();
					copyField(profileId, token.entryPath, peek(field), plugin);
				}}>📋</button>
		`, root);

		if (showSaved && editBtnRef.value) {
			const btn = editBtnRef.value;
			setTimeout(() => {
				// Verify button is still in DOM before updating
				if (!btn.isConnected) return;
				btn.textContent = '✏️';
				btn.className = 'vaultcrypt-chip-btn';
			}, 1500);
		}
	}

	// ── Inline editing (single-line) ─────────────────────────────────────────

	function renderEditingInline(value: string) {
		cleanupPopover();
		root.className = 'vaultcrypt-chip vaultcrypt-chip-editing';
		root.dataset.vcCopyText = value;

		const inputRef = createRef<HTMLInputElement>();
		let saving = false;

		render(html`
			<span class="vaultcrypt-chip-icon vaultcrypt-chip-icon-unlocked"
				title="Click to mask (cancels edit)"
				@click=${(evt: MouseEvent) => {
					evt.stopPropagation();
					editState.set(null);
					chipState.set('masked');
				}}>🔓</span>
			<input ${ref(inputRef)}
				type="text"
				class="vaultcrypt-chip-input"
				.value=${value}
				size=${Math.max(value.length, 8)}
				@input=${() => {
					const input = inputRef.value;
					if (input) input.size = Math.max(input.value.length, 8);
				}}
				@keydown=${(evt: KeyboardEvent) => {
					evt.stopPropagation();
					const input = inputRef.value;
					if (!input) return;
					if (evt.key === 'Enter') {
						evt.preventDefault();
						saving = true;
						void saveEdit(input.value).then((saved) => {
							saving = false;
							if (saved) editState.set(null);
						});
					} else if (evt.key === 'Escape') {
						evt.preventDefault();
						editState.set(null);
					}
				}}
				@blur=${(evt: FocusEvent) => {
					const input = inputRef.value;
					if (!input || saving) return;
					if (peek(editState) === null || peek(editState)?.mode !== 'inline') return;
					if (evt.relatedTarget instanceof Node && root.contains(evt.relatedTarget)) return;
					if (peek(saveOnBlur)) {
						void saveEdit(input.value).then((saved) => {
							if (saved) editState.set(null);
						});
					} else {
						editState.set(null);
					}
				}}
				@click=${(evt: MouseEvent) => evt.stopPropagation()}
				@mousedown=${(evt: MouseEvent) => evt.stopPropagation()}>
			<button class="vaultcrypt-chip-btn" title="Expand to multi-line"
				@mousedown=${(evt: MouseEvent) => {
					evt.preventDefault();
					evt.stopPropagation();
				}}
				@click=${(evt: MouseEvent) => {
					evt.stopPropagation();
					const input = inputRef.value;
					if (input) editState.set({mode: 'multiline', value: input.value});
				}}>⤢</button>
		`, root);

		requestAnimationFrame(() => {
			const input = inputRef.value;
			if (input) {
				input.focus();
				input.select();
			}
		});
	}

	// ── Inline editing (multi-line popover) ──────────────────────────────────

	function renderEditingMultiline(value: string) {
		cleanupPopover();
		root.className = 'vaultcrypt-chip vaultcrypt-chip-editing';
		root.dataset.vcCopyText = value;

		render(html`
			<span class="vaultcrypt-chip-icon vaultcrypt-chip-icon-unlocked">🔓</span>
			<span class="vaultcrypt-chip-value">editing\u2026</span>
		`, root);

		// Create and position popover (appended to document.body for z-index)
		const popover = document.createElement('div');
		popover.className = 'vaultcrypt-edit-popover';

		const textareaRef = createRef<HTMLTextAreaElement>();
		const collapseBtnRef = createRef<HTMLButtonElement>();

		render(html`
			<textarea ${ref(textareaRef)}
				.value=${value}
				rows=${Math.min(Math.max(value.split('\n').length, 3), 12)}
				@input=${() => {
					const textarea = textareaRef.value;
					const collapseBtn = collapseBtnRef.value;
					if (textarea && collapseBtn) {
						collapseBtn.disabled = textarea.value.includes('\n');
					}
				}}
				@keydown=${(evt: KeyboardEvent) => {
					evt.stopPropagation();
					const textarea = textareaRef.value;
					if (!textarea) return;
					if (evt.key === 'Escape') {
						evt.preventDefault();
						editState.set(null);
					} else if (evt.key === 'Enter' && (evt.ctrlKey || evt.metaKey)) {
						evt.preventDefault();
						void saveEdit(textarea.value).then((saved) => {
							if (saved) editState.set(null);
						});
					}
				}}></textarea>
			<div class="vaultcrypt-edit-popover-buttons">
				<button ${ref(collapseBtnRef)}
					title="Collapse to single-line input"
					?disabled=${value.includes('\n')}
					@click=${(evt: MouseEvent) => {
						evt.stopPropagation();
						const collapseBtn = collapseBtnRef.value;
						const textarea = textareaRef.value;
						if (collapseBtn?.disabled || !textarea) return;
						editState.set({mode: 'inline', value: textarea.value});
					}}>⤡ Single-line</button>
				<button @click=${(evt: MouseEvent) => {
					evt.stopPropagation();
					editState.set(null);
				}}>Cancel</button>
				<button class="mod-cta"
					@click=${(evt: MouseEvent) => {
						evt.stopPropagation();
						const textarea = textareaRef.value;
						if (!textarea) return;
						void saveEdit(textarea.value).then((saved) => {
							if (saved) editState.set(null);
						});
					}}>Save</button>
			</div>
		`, popover);

		// Click outside popover → save or discard based on setting
		function onClickOutside(evt: MouseEvent) {
			const target = evt.target as Node;
			if (!popover.contains(target) && !root.contains(target)) {
				document.removeEventListener('mousedown', onClickOutside, true);
				const textarea = textareaRef.value;
				if (peek(saveOnBlur) && textarea) {
					void saveEdit(textarea.value).then((saved) => {
						if (saved) editState.set(null);
					});
				} else {
					editState.set(null);
				}
			}
		}

		// Delay adding the listener so the current click doesn't immediately close it
		requestAnimationFrame(() => {
			document.addEventListener('mousedown', onClickOutside, true);
		});

		// Position below the chip, clamped to viewport
		document.body.appendChild(popover);
		const rect = root.getBoundingClientRect();
		const margin = 4;
		const popW = popover.offsetWidth;
		const popH = popover.offsetHeight;
		const vw = window.innerWidth;
		const vh = window.innerHeight;

		// Flip above the chip if not enough room below
		const top = (rect.bottom + popH + margin > vh && rect.top - popH - margin >= 0)
			? rect.top - popH - margin
			: rect.bottom + margin;
		// Clamp horizontally
		const left = Math.max(margin, Math.min(rect.left, vw - popW - margin));

		popover.style.top = `${top}px`;
		popover.style.left = `${left}px`;
		activePopover = popover;

		// Store cleanup for the click-outside listener
		cleanupPopover = function () {
			document.removeEventListener('mousedown', onClickOutside, true);
			if (activePopover) {
				activePopover.remove();
				activePopover = null;
			}
		};

		requestAnimationFrame(() => {
			const textarea = textareaRef.value;
			if (textarea) {
				textarea.focus();
				textarea.setSelectionRange(textarea.value.length, textarea.value.length);
			}
		});
	}

	// ── Save helper ──────────────────────────────────────────────────────────

	async function saveEdit(newValue: string): Promise<boolean> {
		const config = peek(profileConfig);
		if (!config) {
			new Notice('Profile configuration not found');
			return false;
		}
		try {
			await plugin.sessionService.setFieldValue(
				profileId,
				token.entryPath,
				peek(field),
				newValue,
				config.path,
			);
			root.dataset.vcCopyText = newValue;
			justSaved.set(true);
			return true;
		} catch (err) {
			console.error('[VaultCrypt] Failed to save field', err);
			new Notice(`Failed to save: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	return root;
}

// ── Module-level helpers ───────────────────────────────────────────────────────

function copyField(
	profileId: string,
	entryPath: string,
	fieldName: string,
	plugin: VaultCryptPlugin,
): void {
	const rawValue = plugin.sessionService?.getFieldValue(profileId, entryPath, fieldName);
	if (rawValue === null || rawValue === undefined) {
		new Notice('Could not read value — is the profile still unlocked?');
		return;
	}
	const value: string = rawValue;

	const secs = plugin.settings.security.clipboardClearSeconds;
	function onCopySuccess() {
		const msg = (secs > 0) ? `Copied to clipboard (clears in ${secs}s)` : 'Copied to clipboard';
		new Notice(msg, 3000);
		if (secs > 0) {
			plugin.scheduleClearClipboardTime(value, secs);
		}
	}

	navigator.clipboard.writeText(value).then(onCopySuccess).catch(() => {
		new Notice('Failed to copy to clipboard');
	});
}
