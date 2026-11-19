import {parseVcTokens, type ParsedVcToken} from './inline-parser';

export const LIVE_TABLE_LANGUAGE = 'vaultcrypt-table';

export function parseLiveTableReference(source: string): ParsedVcToken | null {
	const reference = source.trim();
	const raw = reference.startsWith('{{vc:') ? reference : `{{vc:${reference}}}`;
	const token = parseVcTokens(raw)[0];
	if (token?.raw !== raw || token.fieldName !== null || token.entryPath.split('/').some(segment => !segment)) return null;
	return token;
}

export function buildLiveTableBlock(profileId: string, entryPath: string): string | null {
	const entry = `${profileId}/${entryPath}`;
	// Closing braces preserve trailing spaces in a title when the block is trimmed.
	const reference = entryPath.endsWith(' ') ? `{{vc:${entry}}}` : entry;
	const token = parseLiveTableReference(reference);
	if (token?.profileId !== profileId || token.entryPath !== entryPath) return null;
	return ['```' + LIVE_TABLE_LANGUAGE, reference, '```'].join('\n');
}

/** Find live table references in standalone fenced blocks when opening a note. */
export function getLiveTableProfileIds(markdown: string): string[] {
	if (!markdown.includes(LIVE_TABLE_LANGUAGE)) return [];
	const profileIds: string[] = [];
	let fence: {marker: string; isLiveTable: boolean; lines: string[]} | undefined;
	for (const line of markdown.split(/\r?\n/)) {
		const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		const marker = match?.[1];
		const info = match?.[2] ?? '';
		if (fence) {
			if (marker?.startsWith(fence.marker) && !info.trim()) {
				if (fence.isLiveTable) {
					const token = parseLiveTableReference(fence.lines.join('\n'));
					if (token) profileIds.push(token.profileId);
				}
				fence = undefined;
			} else if (fence.isLiveTable) {
				fence.lines.push(line);
			}
		} else if (marker && (marker.startsWith('~') || !info.includes('`'))) {
			fence = {marker, isLiveTable: info.trim() === LIVE_TABLE_LANGUAGE, lines: []};
		}
	}
	return profileIds;
}
