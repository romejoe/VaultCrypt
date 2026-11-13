import {createRequire} from 'node:module';
import {build} from 'esbuild';

// Bundle real services in memory with only the Obsidian host replaced.
export async function loadObsidianRuntime(contents) {
	const {outputFiles} = await build({
		stdin: {contents, resolveDir: process.cwd()},
		bundle: true,
		write: false,
		format: 'cjs',
		platform: 'node',
		plugins: [{
			name: 'obsidian-test-runtime',
			setup(builder) {
				builder.onResolve({filter: /^obsidian$/}, () => ({path: 'obsidian', namespace: 'test'}));
				builder.onLoad({filter: /.*/, namespace: 'test'}, () => ({contents: `
					export class TFile { constructor(path) { this.path = path; } }
					export class TFolder {}
					export class Modal { constructor(app) { this.app = app; } }
					export class Notice {
						static messages = [];
						constructor(message) { Notice.messages.push(message); }
					}
					export class Setting {}
				`}));
			},
		}],
	});
	const module = {exports: {}};
	new Function('require', 'module', 'exports', outputFiles[0].text)(
		createRequire(import.meta.url), module, module.exports,
	);
	return module.exports;
}
