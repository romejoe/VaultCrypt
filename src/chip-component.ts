import {Notice} from 'obsidian';
import {UnlockModal} from './modals';
import {ParsedVcToken, resolveFieldName} from './inline-parser';
import type VaultCryptPlugin from './main';
import {VcTokenEvent} from "./editor-extension";
import {effect} from "@maverick-js/signals";

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
	console.log('buildChipElement', token.raw);
	const profileId = token.profileId.toLowerCase();
	const profileConfig = plugin.settings.profiles[profileId];

	const root = document.createElement('span');

	if (!profileConfig) {
		root.className = 'vaultcrypt-chip vaultcrypt-chip-error';
		root.textContent = `⚠ unknown profile: ${token.profileId}`;
		return root;
	}

	const field = resolveFieldName(token, profileConfig.defaultField);
	const tooltipPath = `${profileId}/${token.entryPath}#${field}`;
	const compact = plugin.settings.general.compactChips;

	root.title = tooltipPath;
	effect(() => {

	})
	root.addEventListener('vc-token-event', (evt: CustomEvent<VcTokenEvent>) => {
		const detail = evt.detail;
		if (detail.type === 'profile-lock' && detail.profileId.toLowerCase() === profileId) {
			renderLocked();
		}
	});

	// ── Inner render functions — each clears root's children then repopulates ──

	function renderLocked() {
		console.log('renderLocked');
		root.className = 'vaultcrypt-chip vaultcrypt-chip-locked';
		root.replaceChildren();
		const label = document.createElement('span');
		label.textContent = compact ? '🔒 ••••••••' : `🔒 ${tooltipPath}`;
		label.addEventListener('click', (evt) => {
			evt.stopPropagation();
			new UnlockModal(plugin.app, plugin, profileId, () => renderMasked()).open();
		});

		root.appendChild(label);
	}

	function renderMasked() {
		root.className = 'vaultcrypt-chip vaultcrypt-chip-masked';
		root.replaceChildren();

		const iconEl = document.createElement('span');
		iconEl.textContent = '🔒';
		iconEl.style.cursor = 'pointer';
		iconEl.addEventListener('click', (evt) => { evt.stopPropagation(); tryReveal(); });

		const dotsEl = document.createElement('span');
		dotsEl.className = 'vaultcrypt-chip-dots';
		dotsEl.textContent = '••••••••';
		dotsEl.style.cursor = 'pointer';
		dotsEl.addEventListener('click', (evt) => { evt.stopPropagation(); tryReveal(); });

		const copyBtn = makeButton('📋', 'Copy to clipboard');
		copyBtn.addEventListener('click', (evt) => {
			evt.stopPropagation();
			copyField(profileId, token.entryPath, field, plugin);
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
		iconEl.style.cursor = 'pointer';
		iconEl.title = 'Click to mask';
		iconEl.addEventListener('click', (evt) => { evt.stopPropagation(); renderMasked(); });

		const valueEl = document.createElement('span');
		valueEl.className = 'vaultcrypt-chip-value';
		valueEl.textContent = value;
		valueEl.style.cursor = 'pointer';
		valueEl.title = 'Click to mask';
		valueEl.addEventListener('click', (evt) => { evt.stopPropagation(); renderMasked(); });

		const editBtn = makeButton('✏️', 'Edit (coming soon)');
		editBtn.addEventListener('click', (evt) => {
			evt.stopPropagation();
			new Notice('Edit — coming soon');
		});

		const copyBtn = makeButton('📋', 'Copy to clipboard');
		copyBtn.addEventListener('click', (evt) => {
			evt.stopPropagation();
			copyField(profileId, token.entryPath, field, plugin);
		});

		root.appendChild(iconEl);
		root.appendChild(valueEl);
		if (!compact) root.appendChild(editBtn);
		root.appendChild(copyBtn);
	}

	function tryReveal() {
		const value = plugin.sessionService?.getFieldValue(profileId, token.entryPath, field);
		if (value === null || value === undefined) {
			new Notice('Could not read value — is the profile still unlocked?');
			return;
		}
		renderRevealed(value);
	}

	// ── Initial render ────────────────────────────────────────────────────────

	if (!plugin.sessionService.isUnlocked(profileId)) {
		renderLocked();
	} else {
		renderMasked();
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
		new Notice(`Copied! Clipboard will clear in ${secs}s`);
		plugin.scheduleClearClipboardTime(value, secs);
	}).catch(() => {
		new Notice('Failed to copy to clipboard');
	});
}
