export type DeepReadonly<T> = {
	readonly [P in keyof T]: DeepReadonly<T[P]>;
};

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
