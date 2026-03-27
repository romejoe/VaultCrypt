import {VC_TOKEN_REGEX, parseVcTokens} from './inline-parser';
import type VaultCryptPlugin from './main';
import type {EditorView} from '@codemirror/view';

/**
 * Builds a clipboard-safe string from the current browser selection by
 * replacing VaultCrypt chip elements with their appropriate copy text
 * (plaintext when revealed, placeholder otherwise).
 *
 * Used for reading mode where chips are standard DOM elements.
 * Returns `null` when the selection contains no VaultCrypt chips,
 * signalling the caller should let the default copy behaviour proceed.
 */
export function buildCopyTextFromSelection(
	selection: Selection,
	plugin: VaultCryptPlugin,
): string | null {
	if (selection.rangeCount === 0) return null;

	let containsChip = false;
	let result = '';

	for (let i = 0; i < selection.rangeCount; i++) {
		const range = selection.getRangeAt(i);
		const fragment = range.cloneContents();
		result += walkNode(fragment);
	}

	if (!containsChip) return null;
	return result;

	// ── recursive walk ──────────────────────────────────────────────────

	function walkNode(node: Node): string {
		// Text node — include content, with safety-net replacement of raw tokens
		if (node.nodeType === Node.TEXT_NODE) {
			const text = node.textContent ?? '';
			const re = new RegExp(VC_TOKEN_REGEX.source, 'g');
			if (!re.test(text)) return text;

			// Replace any leaked raw {{vc:...}} tokens
			containsChip = true;
			const re2 = new RegExp(VC_TOKEN_REGEX.source, 'g');
			return text.replace(re2, (_match, profileId: string, entryPath: string, fieldName?: string) => {
				return resolveTokenCopyText(plugin, profileId, entryPath, fieldName ?? null);
			});
		}

		// Element node
		if (node.nodeType === Node.ELEMENT_NODE) {
			const el = node as HTMLElement;

			// VaultCrypt chip — use stored copy text, skip children
			if (el.dataset.vcChip !== undefined) {
				containsChip = true;
				return el.dataset.vcCopyText ?? '[encrypted]';
			}

			// Recurse into children
			let text = '';
			for (let j = 0; j < el.childNodes.length; j++) {
				text += walkNode(el.childNodes[j]!);
			}
			return text;
		}

		return '';
	}
}

/**
 * Builds a clipboard-safe string from a CM6 editor view's selection by
 * parsing the document text for vc tokens and replacing each with the
 * appropriate copy text from the chip widget's DOM element.
 *
 * Returns `null` when the selection contains no VaultCrypt tokens.
 */
export function buildCopyTextFromEditorSelection(
	view: EditorView,
	plugin: VaultCryptPlugin,
): string | null {
	const {state} = view;
	const ranges = state.selection.ranges;

	let hasToken = false;
	const parts: string[] = [];

	for (const range of ranges) {
		if (range.empty) continue;
		const text = state.sliceDoc(range.from, range.to);
		const tokens = parseVcTokens(text);

		if (tokens.length === 0) {
			parts.push(text);
			continue;
		}

		hasToken = true;
		let cursor = 0;
		let result = '';

		for (const token of tokens) {
			result += text.slice(cursor, token.from);

			// Try to find the chip widget element in the editor DOM
			const absFrom = range.from + token.from;
			const chipEl = findChipAtPos(view, absFrom);
			if (chipEl) {
				result += chipEl.dataset.vcCopyText ?? '[encrypted]';
			} else {
				// Token is visible as raw text (e.g. cursor inside it) — use fallback
				result += resolveTokenCopyText(plugin, token.profileId, token.entryPath, token.fieldName);
			}

			cursor = token.to;
		}

		result += text.slice(cursor);
		parts.push(result);
	}

	if (!hasToken) return null;
	return parts.join(state.lineBreak);
}

/**
 * Locates the chip widget DOM element rendered at a given document position.
 */
function findChipAtPos(view: EditorView, pos: number): HTMLElement | null {
	try {
		const domPos = view.domAtPos(pos);
		const node = domPos.node;
		const el = node instanceof HTMLElement ? node : node.parentElement;
		if (!el) return null;
		return el.closest<HTMLElement>('[data-vc-chip]') ??
			el.querySelector<HTMLElement>('[data-vc-chip]') ??
			null;
	} catch {
		return null;
	}
}

/**
 * Determines the appropriate clipboard text for a raw `{{vc:...}}` token
 * that was found in a text node (e.g. when cursor is inside the token in
 * CM6 and the decoration is suppressed).
 */
function resolveTokenCopyText(
	plugin: VaultCryptPlugin,
	profileId: string,
	_entryPath: string,
	_fieldName: string | null,
): string {
	const pid = profileId.toLowerCase();
	const config = plugin.settings.profiles[pid];
	if (!config) return '[unknown]';

	const isLocked = plugin.vaultCryptState$().profiles.find(
		p => p.id === pid,
	)?.isLocked ?? true;

	if (isLocked) return '[locked]';

	// Profile is unlocked but the raw token is visible (cursor inside it),
	// so the chip is not rendered and there is no revealed/masked state.
	// Default to [encrypted] to avoid leaking plaintext without explicit reveal.
	return '[encrypted]';
}
