import type {App} from 'obsidian';
import {BinaryStream, Kdbx, KdbxContext, KdbxHeader} from 'kdbxweb';
import {readKdbxFile} from './kdbx-file';
import type {KdbxVersion} from './kdbx-service';
import {MAX_PROFILE_NAME_LENGTH} from './profile-name';
import type {VaultCryptSettings} from './settings';
import type {DeepReadonly} from './utils';

export interface VaultImportSelection {
	path: string;
	name: string;
}

export interface ImportableVault extends VaultImportSelection {
	version: KdbxVersion;
}

function isDescendant(path: string, directory: string): boolean {
	return path.startsWith(`${directory}/`)
		&& !path.includes('\\')
		&& !path.split('/').some(segment => segment === '.' || segment === '..');
}

export function isImportableVaultPath(path: string, directory: string, keyringPath: string): boolean {
	return isDescendant(path, directory)
		&& /\.kdbx$/i.test(path)
		&& path.toLowerCase() !== keyringPath.toLowerCase()
		&& !/\/_keyring\.kdbx$/i.test(path);
}

/** Read the public KDBX header without unlocking or modifying the database. */
export async function readVaultVersion(app: App, path: string): Promise<KdbxVersion | null> {
	const buffer = await readKdbxFile(app, path);
	try {
		const stream = new BinaryStream(buffer);
		const {versionMajor} = KdbxHeader.read(stream, new KdbxContext({kdbx: new Kdbx()}));
		if (stream.pos < buffer.byteLength && (versionMajor === 3 || versionMajor === 4)) return versionMajor;
	} catch {
		// Unrecognized, malformed, or unsupported header.
	}
	return null;
}

export async function scanForVaults(app: App, settings: DeepReadonly<VaultCryptSettings>, signal: AbortSignal) {
	const directory = settings.general.vaultCryptDir;
	const registered = new Set(Object.values(settings.profiles).map(profile => profile.path));
	const paths = new Set<string>();
	const folders = new Set([directory]);
	for (const folder of folders) {
		signal.throwIfAborted();
		const listing = await app.vault.adapter.list(folder);
		for (const child of listing.folders) {
			if (isDescendant(child, directory)) folders.add(child);
		}
		for (const path of listing.files) {
			if (!registered.has(path) && isImportableVaultPath(path, directory, settings.masterKeyringPath)) paths.add(path);
		}
	}

	const candidates: ImportableVault[] = [];
	const usedNames = new Set(Object.keys(settings.profiles).map(name => name.toLowerCase()));
	let unreadable = 0;
	for (const path of [...paths].sort()) {
		signal.throwIfAborted();
		const version = await readVaultVersion(app, path).catch(() => {
			unreadable++;
			return null;
		});
		if (version === null) continue;
		const name = suggestProfileName(path, usedNames);
		usedNames.add(name);
		candidates.push({path, name, version});
	}
	return {directory, candidates, unreadable};
}

function suggestProfileName(path: string, usedNames: Set<string>): string {
	const filename = path.slice(path.lastIndexOf('/') + 1, -'.kdbx'.length).trim();
	const base = filename.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '') || 'vault';
	let name = base.slice(0, MAX_PROFILE_NAME_LENGTH);
	for (let index = 2; usedNames.has(name); index++) {
		const suffix = `-${index}`;
		name = `${base.slice(0, MAX_PROFILE_NAME_LENGTH - suffix.length)}${suffix}`;
	}
	return name;
}
