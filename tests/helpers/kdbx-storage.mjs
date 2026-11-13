import {loadObsidianRuntime} from './obsidian-runtime.mjs';

// Real KDBX encryption and service code, with only the Obsidian host mocked.
export const {KdbxService, ProfileService, KeyringService, signal, UnlockSessionService, UnlockModal, KdbxFileError, readKdbxFile, writeKdbxFile, TFile, TFolder} = await loadObsidianRuntime(`
	export {KdbxService} from './src/kdbx-service.ts';
	export {ProfileService} from './src/profile-service.ts';
	export {KeyringService} from './src/keyring-service.ts';
	export {signal} from '@maverick-js/signals';
	export {UnlockSessionService} from './src/unlock-session.ts';
	export {UnlockModal} from './src/modals/unlock-modal.ts';
	export {KdbxFileError, readKdbxFile, writeKdbxFile} from './src/kdbx-file.ts';
	export {TFile, TFolder} from 'obsidian';
`);

export function fixture({indexed = false} = {}) {
	const disk = new Map();
	const index = new Map();
	const folders = new Set();
	const calls = [];
	const app = {vault: {
		getAbstractFileByPath: path => index.get(path) ?? null,
		adapter: {
			async stat(path) {
				if (folders.has(path)) return {type: 'folder'};
				return disk.has(path) ? {type: 'file'} : null;
			},
			async readBinary(path) {
				calls.push('adapter.read');
				if (!disk.has(path)) throw new Error('ENOENT');
				return disk.get(path).slice(0);
			},
			async writeBinary(path, buffer) {
				calls.push('adapter.write');
				disk.set(path, buffer.slice(0));
			},
		},
		async readBinary(file) { calls.push('vault.read'); return disk.get(file.path).slice(0); },
		async modifyBinary(file, buffer) { calls.push('vault.modify'); disk.set(file.path, buffer.slice(0)); },
		async createBinary(path, buffer) {
			calls.push('vault.create');
			if (disk.has(path)) throw new Error('File already exists');
			disk.set(path, buffer.slice(0));
			if (indexed) index.set(path, new TFile(path));
		},
	}};
	return {app, disk, index, folders, calls};
}
