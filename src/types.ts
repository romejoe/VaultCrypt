import { KdbxVersion } from './kdbx-service';

export interface VaultCryptProfile {
	id: string;
	name: string;
	path: string;
	kdbxVersion: KdbxVersion;
	autoLockMinutes: number;
	managedByKeyring: boolean;
	isLocked: boolean;
	lastUnlock: Date | null;
}

export interface VaultCryptState {
	profiles: VaultCryptProfile[];
	currentProfile: VaultCryptProfile | null;
	isLocked: boolean;
}
