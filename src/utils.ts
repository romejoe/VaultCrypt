import { App, TFile, TFolder } from 'obsidian';

export type DeepReadonly<T> = {
	readonly [P in keyof T]: DeepReadonly<T[P]>;
};

/** Returns a TFile for the given vault-relative path, or null if absent or not a file. */
export function getVaultFile(app: App, path: string): TFile | null {
	const f = app.vault.getAbstractFileByPath(path);
	return f instanceof TFile ? f : null;
}

/** Returns a TFolder for the given vault-relative path, or null if absent or not a folder. */
export function getVaultFolder(app: App, path: string): TFolder | null {
	const f = app.vault.getAbstractFileByPath(path);
	return f instanceof TFolder ? f : null;
}

export function deepFreeze<T extends object>(obj: T): DeepReadonly<T> {
	// Retrieve the property names defined on object
	const propNames = Reflect.ownKeys(obj);

	// Freeze properties before freezing self
	for (const name of propNames) {
		const value = obj[name as keyof T];

		if ((value && typeof value === "object") || typeof value === "function") {
			deepFreeze(value as object);
		}
	}

	return Object.freeze(obj) as DeepReadonly<T>;
}
