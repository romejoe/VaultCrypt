import type {Editor} from 'obsidian';
import {ATTACHMENT_PREFIX, parseVcTokens, VALID_TOKEN_SEGMENT} from './inline-parser';

export function buildEntryTable(
	profileId: string,
	entryPath: string,
	fieldNames: readonly string[],
	attachmentNames: readonly string[],
): string | null {
	const entryReference = `{{vc:${profileId}/${entryPath}`;
	const entryToken = parseVcTokens(`${entryReference}}}`)[0];
	if (entryToken?.profileId !== profileId || entryToken.entryPath !== entryPath || entryToken.fieldName !== null) return null;

	const references = getEntryTableFields(fieldNames, attachmentNames);
	if (!references.length) return null;

	const rows = references.map(name => {
		const label = name.replace(/_/g, '\\_');
		// Code spans keep Markdown from splitting tokens at underscores or autolinks.
		return `| ${label} | \`${entryReference}#${name}}}\` |`;
	});
	return ['| Field | Value |', '| --- | --- |', ...rows].join('\n');
}

export function getEntryTableFields(fieldNames: readonly string[], attachmentNames: readonly string[]): string[] {
	const fields = fieldNames.filter(name => name !== 'Title' && !name.startsWith(ATTACHMENT_PREFIX));
	return [...fields, ...attachmentNames.map(name => `${ATTACHMENT_PREFIX}${name}`)]
		.filter(name => VALID_TOKEN_SEGMENT.test(name));
}

export function insertMarkdownBlock(editor: Editor, markdown: string): void {
	const cursor = editor.getCursor();
	const {line, ch} = cursor;
	const lineText = editor.getLine(line);
	const left = lineText.slice(0, ch);
	const right = lineText.slice(ch);

	// Keep the block separate without consuming text at the cursor.
	const before = left
		? (left.trim() ? '\n\n' : '\n')
		: (line > 0 && editor.getLine(line - 1).trim() ? '\n' : '');
	const after = right
		? (right.trim() ? '\n\n' : '\n')
		: (line + 1 < editor.lineCount() && editor.getLine(line + 1).trim() ? '\n' : '');
	editor.replaceRange(before + markdown + after, cursor);
}
