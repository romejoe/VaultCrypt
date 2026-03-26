import {Notice} from 'obsidian';
import {UnlockModal} from './modals';
import {ParsedVcToken, resolveFieldName} from './inline-parser';
import type VaultCryptPlugin from './main';
import {computed, effect, peek, signal} from "@maverick-js/signals";

/**
 * Builds an interactive inline chip element for a parsed {{vc:...}} token.
 *
 * A single root <span> is created and its children are mutated in-place
 * whenever state changes (locked → masked → revealed → masked …). This is
 * critical for the CodeMirror live-preview mode, which owns the root element
 * and would discard any element that replaces it via replaceWith().
 *
 * State machine:
 *   unknown profile  →  error chip (static)
 *   profile locked   →  locked chip (click to unlock)
 *   profile unlocked →  masked chip (copy) ⟷ revealed chip (show value, edit stub, copy)
 */
export function buildChipElement(token: ParsedVcToken, plugin: VaultCryptPlugin): HTMLElement {
	const profileId = token.profileId.toLowerCase();

	const profileConfig = computed(() => {
		return plugin.settings$().profiles[profileId];
	});

	const compact = computed(() => {
		return plugin.settings$().general.compactChips;
	});

	const autoUnmask = computed(() => {
		return plugin.settings$().general.autoUnmask;
	});

	const root = document.createElement('span');
	const chipState = signal<'locked' | 'masked' | 'revealed' | 'unknown'>('locked');


	const field = computed(() => {
		const config = profileConfig();
		return resolveFieldName(token, config?.defaultField ?? 'Password')
	});

	const tooltipPath = computed(() => {
		return `${profileId}/${token.entryPath}#${field()}`;
	})


	effect(() => {
		root.title = tooltipPath();
	});


	effect(() => {
		const currentState = chipState();
		const pluginState = plugin.vaultCryptState$();

		const profileLocked = pluginState.profiles.find(profile => {
			return profile.id === profileId;
		})?.isLocked ?? true;

		if (profileLocked) {
			chipState.set('locked');
			return;
		}

		if (currentState === 'unknown' || currentState === 'revealed') {
			return;
		}

		if (currentState === 'locked') {
			chipState.set(peek(autoUnmask) ? 'revealed' : 'masked');
		}
	});


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
			const value = plugin.sessionService?.getFieldValue(profileId, token.entryPath, field());
			if (value === null || value === undefined) {
				new Notice('Could not read value — is the profile still unlocked?');
				chipState.set('masked');
			} else {
				renderRevealed(value);
			}
		}
	});

	// ── Inner render functions — each clears root's children then repopulates ──

	function renderUnknown() {
		if (!profileConfig) {
			root.className = 'vaultcrypt-chip vaultcrypt-chip-error';
			root.textContent = `⚠ unknown profile: ${token.profileId}`;
		}
	}

	function renderLocked() {
		root.className = 'vaultcrypt-chip vaultcrypt-chip-locked';
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

	function renderRevealed(value: string) {
		root.className = 'vaultcrypt-chip vaultcrypt-chip-revealed';
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


		const editBtn = makeButton('✏️', 'Edit (coming soon)');
		editBtn.addEventListener('click', (evt) => {
			evt.stopPropagation();
			new Notice('Edit — coming soon');
		});

		const copyBtn = makeButton('📋', 'Copy to clipboard');
		copyBtn.addEventListener('click', (evt) => {
			evt.stopPropagation();
			copyField(profileId, token.entryPath, peek(field), plugin);
		});

		root.appendChild(iconEl);
		root.appendChild(valueEl);
		if (!compact) root.appendChild(editBtn);
		root.appendChild(copyBtn);
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
	const value = plugin.sessionService?.getFieldValue(profileId, entryPath, fieldName);
	if (value === null || value === undefined) {
		new Notice('Could not read value — is the profile still unlocked?');
		return;
	}

	navigator.clipboard.writeText(value).then(() => {
		const secs = plugin.settings.security.clipboardClearSeconds;
		if (secs === undefined || secs <= 0) return;

		new Notice(`Copied! Clipboard will clear in ${secs}s`);
		plugin.scheduleClearClipboardTime(value, secs);
	}).catch(() => {
		new Notice('Failed to copy to clipboard');
	});
}
