import {Notice} from 'obsidian';
import {UnlockModal} from './modals';
import {ParsedVcToken, resolveFieldName} from './inline-parser';
import type VaultCryptPlugin from './main';

/**
 * Builds an interactive inline chip element for a parsed {{vc:...}} token.
 *
 * State machine:
 *   unknown profile  →  error chip (non-interactive)
 *   profile locked   →  locked chip (click to unlock)
 *   profile unlocked →  masked chip (copy) ⟷ revealed chip (show value, edit stub, copy)
 */
export function buildChipElement(token: ParsedVcToken, plugin: VaultCryptPlugin): HTMLElement {
	const profileId = token.profileId.toLowerCase();
	const profileConfig = plugin.settings.profiles[profileId];

	if (!profileConfig) {
		const span = document.createElement('span');
		span.className = 'vaultcrypt-chip vaultcrypt-chip-error';
		span.textContent = `⚠ unknown profile: ${token.profileId}`;
		return span;
	}

	const field = resolveFieldName(token, profileConfig.defaultField);
	const tooltipPath = `${profileId}/${token.entryPath}/${field}`;
	const compact = plugin.settings.general.compactChips;
	console.log('buildChipElement', token, profileId, field, tooltipPath, compact);

	if (!plugin.sessionService.isUnlocked(profileId)) {
		return buildLockedChip(token, plugin, tooltipPath, compact);
	}

	return buildMaskedChip(token, plugin, field, tooltipPath, compact);
}

// ── Private builders ──────────────────────────────────────────────────────────

function buildLockedChip(
	token: ParsedVcToken,
	plugin: VaultCryptPlugin,
	tooltipPath: string,
	compact: boolean,
): HTMLElement {
	const span = document.createElement('span');
	span.className = 'vaultcrypt-chip vaultcrypt-chip-locked';
	span.title = tooltipPath;
	span.textContent = compact ? '🔒 ••••••••' : `🔒 ${tooltipPath}`;
	span.addEventListener('click', () => {
		new UnlockModal(plugin.app, plugin, token.profileId.toLowerCase(), () => {
			const rebuilt = buildChipElement(token, plugin);
			span.replaceWith(rebuilt);
		}).open();
	});
	return span;
}

function buildMaskedChip(
	token: ParsedVcToken,
	plugin: VaultCryptPlugin,
	fieldName: string,
	tooltipPath: string,
	compact: boolean,
): HTMLElement {
	console.log('buildMaskedChip', token, fieldName, tooltipPath, compact);
	const span = document.createElement('span');
	span.className = 'vaultcrypt-chip vaultcrypt-chip-masked';
	span.title = tooltipPath;

	const iconEl = document.createElement('span');
	iconEl.textContent = '🔒';

	const dotsEl = document.createElement('span');
	dotsEl.className = 'vaultcrypt-chip-dots';
	dotsEl.textContent = '••••••••';

	const copyBtn = makeButton('📋', 'Copy to clipboard');


	// Clicking the icon/dots area toggles reveal
	iconEl.style.cursor = 'pointer';
	dotsEl.style.cursor = 'pointer';
	iconEl.addEventListener('click', (evt) => {
		evt.stopPropagation();
		toggleReveal(span, token, plugin, fieldName, tooltipPath, compact);
	});
	dotsEl.addEventListener('click', (evt) => {
		evt.stopPropagation();
		toggleReveal(span, token, plugin, fieldName, tooltipPath, compact);
	});


	copyBtn.addEventListener('click', (evt) => {
		evt.stopPropagation();
		copyField(token.profileId.toLowerCase(), token.entryPath, fieldName, plugin);
	});

	span.appendChild(iconEl);
	span.appendChild(dotsEl);
	span.appendChild(copyBtn);

	return span;
}

function buildRevealedChip(
	token: ParsedVcToken,
	plugin: VaultCryptPlugin,
	fieldName: string,
	tooltipPath: string,
	value: string,
	compact: boolean,
): HTMLElement {
	const span = document.createElement('span');
	span.className = 'vaultcrypt-chip vaultcrypt-chip-revealed';
	span.title = tooltipPath;

	const iconEl = document.createElement('span');
	iconEl.textContent = '🔓';
	iconEl.style.cursor = 'pointer';
	iconEl.title = 'Click to mask';

	const valueEl = document.createElement('span');
	valueEl.className = 'vaultcrypt-chip-value';
	valueEl.textContent = value;
	valueEl.style.cursor = 'pointer';
	valueEl.title = 'Click to mask';

	const editBtn = makeButton('✏️', 'Edit (coming soon)');
	const copyBtn = makeButton('📋', 'Copy to clipboard');

	// Click icon or value to re-mask
	const maskHandler = (evt: MouseEvent) => {
		evt.stopPropagation();
		const masked = buildMaskedChip(token, plugin, fieldName, tooltipPath, compact);
		span.replaceWith(masked);
	};
	iconEl.addEventListener('click', maskHandler);
	valueEl.addEventListener('click', maskHandler);

	editBtn.addEventListener('click', (evt) => {
		evt.stopPropagation();
		new Notice('Edit — coming soon');
	});

	copyBtn.addEventListener('click', (evt) => {
		evt.stopPropagation();
		copyField(token.profileId.toLowerCase(), token.entryPath, fieldName, plugin);
	});

	span.appendChild(iconEl);
	span.appendChild(valueEl);
	if (!compact) span.appendChild(editBtn);
	span.appendChild(copyBtn);

	return span;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeButton(emoji: string, title: string): HTMLButtonElement {
	const btn = document.createElement('button');
	btn.className = 'vaultcrypt-chip-btn';
	btn.textContent = emoji;
	btn.title = title;
	return btn;
}

function toggleReveal(
	currentChip: HTMLElement,
	token: ParsedVcToken,
	plugin: VaultCryptPlugin,
	fieldName: string,
	tooltipPath: string,
	compact: boolean,
): void {
	console.log('toggleReveal', currentChip, token, fieldName, tooltipPath, compact);
	const profileId = token.profileId.toLowerCase();
	const value = plugin.sessionService?.getFieldValue(profileId, token.entryPath, fieldName);
	if (value === null || value === undefined) {
		new Notice('Could not read value — is the profile still unlocked?');
		return;
	}
	const revealed = buildRevealedChip(token, plugin, fieldName, tooltipPath, value, compact);
	currentChip.replaceWith(revealed);
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
