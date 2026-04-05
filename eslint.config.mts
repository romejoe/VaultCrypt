import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";
import { DEFAULT_BRANDS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.js',
						'manifest.json'
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		rules: {
			'semi': 'error',
			'require-await': 'error'
		}
	},
	{
		plugins: { obsidianmd },
		rules: {
			// Extend the default brand list with VaultCrypt-specific proper nouns
			'obsidianmd/ui/sentence-case': ['error', {
				enforceCamelCaseLower: true,
				brands: [...DEFAULT_BRANDS, 'VaultCrypt', 'KeePassXC', 'KDBX'],
			}],
		}
	},
	globalIgnores([
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
	]),
);
