export const MAX_PROFILE_NAME_LENGTH = 64;

export function validateProfileName(name: string, existingNames: string[]): string | null {
	if (!name) return 'Profile name is required.';
	if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(name)) return 'Name must start with alphanumeric and contain only letters, numbers, and hyphens.';
	if (name.length > MAX_PROFILE_NAME_LENGTH) return `Name must be ${MAX_PROFILE_NAME_LENGTH} characters or fewer.`;
	if (existingNames.some(n => n.toLowerCase() === name.toLowerCase())) return 'A profile with this name already exists.';
	return null;
}
