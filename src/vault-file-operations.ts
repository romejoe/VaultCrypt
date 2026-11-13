import {App} from 'obsidian';
import {getVaultFile, getVaultFolder} from './utils';

/** Prefer Vault events for indexed files; hidden files require the adapter. */
export async function moveVaultFile(app: App, from: string, to: string): Promise<void> {
	// Adapter rename may replace an existing file, so check destinations for both
	// forward moves and rollback. Never overwrite a database to complete a move.
	if (app.vault.getAbstractFileByPath(to) || await app.vault.adapter.stat(to)) {
		throw new Error(`Cannot move file: target already exists: ${to}`);
	}
	const file = getVaultFile(app, from);
	if (file) {
		await app.vault.rename(file, to);
	} else {
		if ((await app.vault.adapter.stat(from))?.type !== 'file') {
			throw new Error(`File not found during move: ${from}`);
		}
		await app.vault.adapter.rename(from, to);
	}
}

/** Check disk contents before trashing migrated directories, including hidden ones. */
export async function removeEmptyVaultFolder(app: App, path: string): Promise<void> {
	const listing = await app.vault.adapter.list(path);
	if (listing.files.length || listing.folders.length) return;
	const folder = getVaultFolder(app, path);
	if (folder) {
		await app.fileManager.trashFile(folder);
	} else {
		// Non-recursive adapter.rmdir can reject even empty folders on desktop.
		// Use recoverable local trash after checking the adapter listing instead.
		await app.vault.adapter.trashLocal(path);
	}
}
