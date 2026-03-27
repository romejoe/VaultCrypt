import {Notice} from 'obsidian';
import {UnlockModal} from './modals';
import {ParsedVcToken, resolveFieldName} from './inline-parser';
import type VaultCryptPlugin from './main';
import {computed, effect, peek, signal, StopEffect} from "@maverick-js/signals";

export const CHIP_DESTROY_EVENT = 'vaultcrypt-destroy';

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
export function buildChipElement(token: ParsedVcToken, plugin: VaultCryptPlugin): HTMLElement {
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
	const editing = signal(false);
	const justSaved = signal(false);

	// Reference to an active multi-line popover for cleanup
	let activePopover: HTMLElement | null = null;

	const field = computed(() => {
		const config = profileConfig();
		return resolveFieldName(token, config?.defaultField ?? 'Password')
	});

	const tooltipPath = computed(() => {
		return `${profileId}/${token.entryPath}#${field()}`;
	})

	let cleanupPopover = () => {
		if (activePopover) {
			activePopover.remove();
			activePopover = null;
		}
	};

	root.addEventListener(CHIP_DESTROY_EVENT, (evt) => {
		cleanupPopover();
		for (const effect of effects) {
			effect?.();
		}
	})


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
				if (peek(editing)) {
					editing.set(false);
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
				if (peek(editing)) return;
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

		effect(() => {
			const isEditing = editing();
			if (isEditing) {
				// Check profile is still unlocked
				if (!plugin.sessionService?.isUnlocked(profileId)) {
					editing.set(false);
					new Notice('Profile is locked — cannot edit.');
					return;
				}
				// Allow editing even if the entry/field doesn't exist yet (start with empty string)
				const value = plugin.sessionService?.getFieldValue(profileId, token.entryPath, peek(field)) ?? '';
				const isMultiline = value.includes('\n') || peek(field).toLowerCase() === 'notes';
				if (isMultiline) {
					renderEditingMultiline(value);
				} else {
					renderEditingInline(value);
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

	// ── Inner render functions — each clears root's children then repopulates ──

	function renderUnknown() {
		if (!peek(profileConfig)) {
			root.className = 'vaultcrypt-chip vaultcrypt-chip-error';
			root.dataset.vcCopyText = '[unknown]';
			root.textContent = `⚠ unknown profile: ${token.profileId}`;
		}
	}

	function renderLocked() {
		root.className = 'vaultcrypt-chip vaultcrypt-chip-locked';
		root.dataset.vcCopyText = '[locked]';
		root.replaceChildren();
		const label = document.createElement('span');
		label.textContent = compact() ? '🔒 ••••••••' : `🔒 ${tooltipPath()}`;
		label.addEventListener('click', (evt) => {
			evt.stopPropagation();
			new UnlockModal(plugin.app, plugin, profileId, () => {
				chipState.set('masked');
			}).open();
		});

		root.appendChild(label);
	}

	function renderMasked() {
		root.className = 'vaultcrypt-chip vaultcrypt-chip-masked';
		root.dataset.vcCopyText = '[encrypted]';
		root.replaceChildren();

		const iconEl = document.createElement('span');
		iconEl.textContent = '🔒';
		iconEl.className = 'vaultcrypt-chip-icon vaultcrypt-chip-icon-locked';

		iconEl.addEventListener('click', (evt) => {
			evt.stopPropagation();
			chipState.set('revealed');
		});

		const dotsEl = document.createElement('span');
		dotsEl.className = 'vaultcrypt-chip-dots';
		dotsEl.textContent = '••••••••';

		dotsEl.addEventListener('click', (evt) => {
			evt.stopPropagation();
			chipState.set('revealed');
		});

		const copyBtn = makeButton('📋', 'Copy to clipboard');
		copyBtn.addEventListener('click', (evt) => {
			evt.stopPropagation();
			copyField(profileId, token.entryPath, peek(field), plugin);
		});

		root.appendChild(iconEl);
		root.appendChild(dotsEl);
		root.appendChild(copyBtn);
	}

	function renderMaskedError(reason: string) {
		root.className = 'vaultcrypt-chip vaultcrypt-chip-masked-error';
		root.dataset.vcCopyText = '[encrypted]';
		root.replaceChildren();

		const iconEl = document.createElement('span');
		iconEl.textContent = '⚠';
		iconEl.className = 'vaultcrypt-chip-icon';

		const labelEl = document.createElement('span');
		labelEl.textContent = reason;

		const editBtn = makeButton('✏️', 'Create and edit');
		editBtn.addEventListener('click', (evt) => {
			evt.stopPropagation();
			editing.set(true);
		});

		const retryBtn = makeButton('🔄', 'Retry');
		retryBtn.addEventListener('click', (evt) => {
			evt.stopPropagation();
			chipState.set('masked');
		});

		root.appendChild(iconEl);
		root.appendChild(labelEl);
		if (!compact()) root.appendChild(editBtn);
		root.appendChild(retryBtn);
	}

	function renderRevealed(value: string) {
		root.className = 'vaultcrypt-chip vaultcrypt-chip-revealed';
		root.dataset.vcCopyText = value;
		root.replaceChildren();

		const iconEl = document.createElement('span');
		iconEl.className = 'vaultcrypt-chip-icon vaultcrypt-chip-icon-unlocked';
		iconEl.textContent = '🔓';
		iconEl.title = 'Click to mask';
		iconEl.addEventListener('click', (evt) => {
			evt.stopPropagation();
			chipState.set('masked');
		});

		const valueEl = document.createElement('span');
		valueEl.className = 'vaultcrypt-chip-value';
		valueEl.textContent = value;

		const editBtn = makeButton('✏️', 'Edit');
		editBtn.addEventListener('click', (evt) => {
			evt.stopPropagation();
			editing.set(true);
		});

		// Show save confirmation checkmark briefly after a successful save
		if (peek(justSaved)) {
			justSaved.set(false);
			editBtn.textContent = '✅';
			editBtn.className = 'vaultcrypt-chip-btn vaultcrypt-chip-btn-saved';
			setTimeout(() => {
				editBtn.textContent = '✏️';
				editBtn.className = 'vaultcrypt-chip-btn';
			}, 1500);
		}

		const copyBtn = makeButton('📋', 'Copy to clipboard');
		copyBtn.addEventListener('click', (evt) => {
			evt.stopPropagation();
			copyField(profileId, token.entryPath, peek(field), plugin);
		});

		root.appendChild(iconEl);
		root.appendChild(valueEl);
		if (!compact()) root.appendChild(editBtn);
		root.appendChild(copyBtn);
	}

	// ── Inline editing (single-line) ─────────────────────────────────────────

	function renderEditingInline(value: string) {
		root.className = 'vaultcrypt-chip vaultcrypt-chip-editing';
		root.dataset.vcCopyText = value;
		root.replaceChildren();

		const iconEl = document.createElement('span');
		iconEl.className = 'vaultcrypt-chip-icon vaultcrypt-chip-icon-unlocked';
		iconEl.textContent = '🔓';
		iconEl.title = 'Click to mask (cancels edit)';
		iconEl.addEventListener('click', (evt) => {
			evt.stopPropagation();
			editing.set(false);
			chipState.set('masked');
		});

		const input = document.createElement('input');
		input.type = 'text';
		input.className = 'vaultcrypt-chip-input';
		input.value = value;
		input.size = Math.max(value.length, 8);

		let saving = false;

		input.addEventListener('input', (evt) => {
			input.size = Math.max(input.value.length, 8);
		});

		input.addEventListener('keydown', (evt) => {
			evt.stopPropagation();
			if (evt.key === 'Enter') {
				evt.preventDefault();
				saving = true;
				saveEdit(input.value).then(() => {
					editing.set(false);
				});
			} else if (evt.key === 'Escape') {
				evt.preventDefault();
				editing.set(false);
			}
		});

		input.addEventListener('blur', () => {
			if (saving) return;
			if (peek(saveOnBlur)) {
				saveEdit(input.value).then(() => {
					editing.set(false);
				});
			} else {
				editing.set(false);
			}
		});

		// Stop click propagation so CodeMirror doesn't steal focus
		input.addEventListener('click', (evt) => evt.stopPropagation());
		input.addEventListener('mousedown', (evt) => evt.stopPropagation());

		root.appendChild(iconEl);
		root.appendChild(input);

		requestAnimationFrame(() => {
			input.focus();
			input.select();
		});
	}

	// ── Inline editing (multi-line popover) ──────────────────────────────────

	function renderEditingMultiline(value: string) {
		root.className = 'vaultcrypt-chip vaultcrypt-chip-editing';
		root.dataset.vcCopyText = value;
		root.replaceChildren();

		const iconEl = document.createElement('span');
		iconEl.className = 'vaultcrypt-chip-icon vaultcrypt-chip-icon-unlocked';
		iconEl.textContent = '🔓';

		const labelEl = document.createElement('span');
		labelEl.className = 'vaultcrypt-chip-value';
		labelEl.textContent = 'editing\u2026';

		root.appendChild(iconEl);
		root.appendChild(labelEl);

		// Create popover
		const popover = document.createElement('div');
		popover.className = 'vaultcrypt-edit-popover';

		const textarea = document.createElement('textarea');
		textarea.value = value;
		textarea.rows = Math.min(Math.max(value.split('\n').length, 3), 12);

		const btnBar = document.createElement('div');
		btnBar.className = 'vaultcrypt-edit-popover-buttons';

		const saveBtn = document.createElement('button');
		saveBtn.textContent = 'Save';
		saveBtn.className = 'mod-cta';
		saveBtn.addEventListener('click', (evt) => {
			evt.stopPropagation();
			saveEdit(textarea.value).then(() => {
				editing.set(false);
			});
		});

		const cancelBtn = document.createElement('button');
		cancelBtn.textContent = 'Cancel';
		cancelBtn.addEventListener('click', (evt) => {
			evt.stopPropagation();
			editing.set(false);
		});

		textarea.addEventListener('keydown', (evt) => {
			evt.stopPropagation();
			if (evt.key === 'Escape') {
				evt.preventDefault();
				editing.set(false);
			} else if (evt.key === 'Enter' && (evt.ctrlKey || evt.metaKey)) {
				evt.preventDefault();
				saveEdit(textarea.value).then(() => {
					editing.set(false);
				});
			}
		});

		// Click outside popover → save or discard based on setting
		function onClickOutside(evt: MouseEvent) {
			const target = evt.target as Node;
			if (!popover.contains(target) && !root.contains(target)) {
				document.removeEventListener('mousedown', onClickOutside, true);
				if (peek(saveOnBlur)) {
					saveEdit(textarea.value).then(() => {
						editing.set(false);
					});
				} else {
					editing.set(false);
				}
			}
		}

		// Delay adding the listener so the current click doesn't immediately close it
		requestAnimationFrame(() => {
			document.addEventListener('mousedown', onClickOutside, true);
		});

		btnBar.appendChild(cancelBtn);
		btnBar.appendChild(saveBtn);
		popover.appendChild(textarea);
		popover.appendChild(btnBar);

		// Position below the chip
		const rect = root.getBoundingClientRect();
		// eslint-disable-next-line obsidianmd/no-static-styles-assignment
		popover.style.top = `${rect.bottom + 4}px`;
		// eslint-disable-next-line obsidianmd/no-static-styles-assignment
		popover.style.left = `${rect.left}px`;

		document.body.appendChild(popover);
		activePopover = popover;

		// Store cleanup for the click-outside listener
		const origCleanup = cleanupPopover;
		cleanupPopover = function () {
			document.removeEventListener('mousedown', onClickOutside, true);
			if (activePopover) {
				activePopover.remove();
				activePopover = null;
			}
		};

		requestAnimationFrame(() => {
			textarea.focus();
			textarea.setSelectionRange(textarea.value.length, textarea.value.length);
		});
	}

	// ── Save helper ──────────────────────────────────────────────────────────

	async function saveEdit(newValue: string): Promise<void> {
		const config = peek(profileConfig);
		if (!config) {
			new Notice('Profile configuration not found');
			return;
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
		} catch (err) {
			console.error('[VaultCrypt] Failed to save field', err);
			new Notice(`Failed to save: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	return root;
}

// ── Module-level helpers ───────────────────────────────────────────────────────

function makeButton(emoji: string, title: string): HTMLButtonElement {
	const btn = document.createElement('button');
	btn.className = 'vaultcrypt-chip-btn';
	btn.textContent = emoji;
	btn.title = title;
	return btn;
}

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
		// Fallback for mobile WebViews where the Clipboard API may be unavailable
		let textarea: HTMLTextAreaElement|null = null;
		try {
			textarea = document.createElement('textarea');
			textarea.value = value;
			// eslint-disable-next-line obsidianmd/no-static-styles-assignment
			textarea.style.cssText = 'position:fixed;opacity:0;';
			document.body.appendChild(textarea);
			textarea.focus();
			textarea.select();
			// eslint-disable-next-line @typescript-eslint/no-deprecated
			const ok = document.execCommand('copy');
			document.body.removeChild(textarea);
			if (ok) {
				onCopySuccess();
			} else {
				new Notice('Failed to copy to clipboard');
			}
		} catch {
			if(textarea !== null){
				textarea.remove();
			}
			new Notice('Failed to copy to clipboard');
		}
	});
}
