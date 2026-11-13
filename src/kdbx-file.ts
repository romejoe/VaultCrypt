import {App} from 'obsidian';
import {getVaultFile} from './utils';

/** Separates storage failures from password/decryption failures in the unlock UI. */
export class KdbxFileError extends Error {
	constructor(message: string, readonly originalError?: unknown) {
		super(message);
		this.name = 'KdbxFileError';
	}
}

// Service instances share a reservation, while independent vaults stay isolated.
const pendingCreations = new WeakMap<App['vault'], Set<string>>();

/** Reserve synchronously before any await; the caller must release in finally. */
export function reserveKdbxCreation(app: App, path: string): () => void {
	let paths = pendingCreations.get(app.vault);
	if (!paths) {
		paths = new Set();
		pendingCreations.set(app.vault, paths);
	}
	if (paths.has(path)) {
		throw new KdbxFileError(`KDBX file is already being created: ${path}`);
	}
	paths.add(path);
	return () => { paths.delete(path); };
}

/** Hidden files are not in Obsidian's vault index; access them through the adapter. */
export async function readKdbxFile(app: App, path: string): Promise<ArrayBuffer> {
	try {
		const file = getVaultFile(app, path);
		if (file) return await app.vault.readBinary(file);
		if ((await app.vault.adapter.stat(path))?.type !== 'file') {
			throw new KdbxFileError(`KDBX file not found: ${path}`);
		}
		return await app.vault.adapter.readBinary(path);
	} catch (error) {
		if (error instanceof KdbxFileError) throw error;
		throw new KdbxFileError(`Could not read KDBX file: ${path}`, error);
	}
}

/** Preserve Vault events for indexed files, and support unindexed database saves. */
export async function writeKdbxFile(app: App, path: string, buffer: ArrayBuffer): Promise<void> {
	try {
		const file = getVaultFile(app, path);
		if (file) {
			await app.vault.modifyBinary(file, buffer);
			return;
		}
		const stat = await app.vault.adapter.stat(path);
		if (stat?.type === 'folder') {
			throw new KdbxFileError(`Cannot save KDBX file: a folder exists at ${path}`);
		}
		if (stat || path.split('/').some(segment => segment.startsWith('.'))) {
			await app.vault.adapter.writeBinary(path, buffer);
		} else {
			await app.vault.createBinary(path, buffer);
		}
	} catch (error) {
		if (error instanceof KdbxFileError) throw error;
		throw new KdbxFileError(`Could not save KDBX file: ${path}`, error);
	}
}
