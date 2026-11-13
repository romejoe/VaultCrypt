// Real CodeMirror and post-processed table chips; no vault or system clipboard access.
import {build} from 'esbuild';
import {spawn} from 'node:child_process';
import {access, writeFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

// Requires an installed Chrome/Chromium; VAULTCRYPT_CHROME_PATH overrides discovery.
const candidates = [
  process.env.VAULTCRYPT_CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
let executable;
for (const candidate of candidates) {
  try { await access(candidate); executable = candidate; break; } catch { /* Try the next browser. */ }
}
if (!executable) throw new Error('Install Chrome/Chromium or set VAULTCRYPT_CHROME_PATH.');

const directory = await mkdtemp(join(tmpdir(), 'vaultcrypt-issue93-'));
const {outputFiles} = await build({
  stdin: {resolveDir: process.cwd(), contents: `
    import {EditorState} from '@codemirror/state';
    import {EditorView} from '@codemirror/view';
    import {editorLivePreviewField} from 'obsidian';
    import {buildEditorExtension} from './src/editor-extension';
    import {buildChipElement} from './src/chip-component';
    import {processVcTokensInDom} from './src/inline-parser';
    import {signal, tick} from '@maverick-js/signals';
    let view;
    Object.defineProperty(navigator, 'clipboard', {value: {writeText: async text => {window.copied = text;}}});
    window.logs = [];
    window.reset = (options = {}) => {
      if (view) view.destroy();
      document.querySelector('#table-fixture')?.remove();
      window.logs = [];
      const settings = {profiles: {test: {defaultField: 'Password', path: 'test.kdbx'}}, general: {compactChips: false, autoUnmask: true, saveOnBlur: false, ...options}, security: {clipboardClearSeconds: 0}};
      window.copied = null; window.saved = null; window.savedAttachment = null;
      const plugin = {settings, settings$: signal(settings), vaultCryptState: {profiles: []}, vaultCryptState$: signal({profiles: [{id: 'test', isLocked: !!options.locked}]}), sessionService: {isUnlocked: () => !options.locked, getFieldValue: () => 'sample value', getEntryFields: () => ({}), getAttachment: () => new TextEncoder().encode('sample attachment'), getEntryTree: () => null, setFieldValue: async (...args) => {window.saved = args[3];}}, app: {vault: {getAbstractFileByPath: () => ({}), createBinary: async path => {window.savedAttachment = path;}}}};
      view = new EditorView({parent: document.querySelector('#editor'), state: EditorState.create({doc: 'Before {{vc:test/entry' + (options.attachment ? '#attachment:sample.txt' : '') + '}} after', extensions: [editorLivePreviewField, buildEditorExtension(plugin), EditorView.updateListener.of(update => { if (update.selectionSet) window.logs.push({event: 'CM selection', head: update.state.selection.main.head}); })]})});
      view.focus();
      tick();
      window.view = view;
      if (options.table) {
        view.destroy();
        const table = document.createElement('table');table.id='table-fixture';
        const cell=table.insertRow().insertCell();cell.style.padding='12px';cell.textContent='cell {{vc:test/entry' + (options.attachment ? '#attachment:sample.txt' : '') + '}} outside';
        window.tableActivations=0;cell.addEventListener('pointerdown',()=>{window.tableActivations++;});
        document.body.append(table);processVcTokensInDom(table, token=>buildChipElement(token,plugin));tick();
      }
    };
    for (const type of ['mousedown', 'mouseup', 'click', 'selectionchange', 'focusin']) document.addEventListener(type, event => { const target = event.target; window.logs.push({event: type, target: target.title || target.className || target.nodeName, prevented: event.defaultPrevented, head: view?.state.selection.main.head}); }, true);
    window.snapshot = () => ({head: view.state.selection.main.head, chip: document.querySelector('[data-vc-chip]')?.className ?? null, input: !!document.querySelector('.vaultcrypt-chip-input'), active: document.activeElement?.className, selection: {anchor: document.getSelection()?.anchorNode?.parentElement?.className, anchorOffset: document.getSelection()?.anchorOffset, focus: document.getSelection()?.focusNode?.parentElement?.className, focusOffset: document.getSelection()?.focusOffset}, logs: window.logs});
    window.reset();
    document.addEventListener('mousedown', event => {window.lastMouseDown = event;}, true);
  `},
  bundle: true, write: false, format: 'iife', platform: 'browser',
  plugins: [{name: 'mock-host', setup(builder) {
    builder.onResolve({filter: /^obsidian$/}, () => ({path: 'host', namespace: 'mock'}));
    builder.onResolve({filter: /^\.\/modals$/}, () => ({path: 'modals', namespace: 'mock'}));
    builder.onLoad({filter: /.*/, namespace: 'mock'}, args => ({contents: args.path === 'host' ? `import {StateField} from '@codemirror/state'; export const editorLivePreviewField = StateField.define({create: () => true, update: value => value}); export class Menu {} export class Notice {} export class TFile {} export const Platform = {isDesktop: true};` : `export class UnlockModal {open() {const modal=document.createElement('div');modal.id='mock-unlock';const input=document.createElement('input');modal.append(input);document.body.append(modal);input.focus();}} export class EditSecretModal {} export class DeleteSecretModal {}`, resolveDir: process.cwd()}));
  }}]
});
const {readFile} = await import('node:fs/promises');
const css = await readFile('styles.css', 'utf8');
const html = `<style>body{padding:40px;font:18px monospace}.cm-editor{border:1px solid gray;width:900px}${css}</style><div id="editor"></div><script>${outputFiles[0].text}</script>`;
await writeFile(join(directory, 'probe.html'), html);
const browser = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-pipe', `--user-data-dir=${join(directory, 'profile')}`], {stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true});
let counter = 0, buffer = '', session;
const pending = new Map();
browser.stdio[4].on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\0')) >= 0) { const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); if (pending.has(value.id)) { const {resolve, reject} = pending.get(value.id); pending.delete(value.id); value.error ? reject(value.error) : resolve(value.result); } } });
function cdp(method, params = {}, sessionId = session) { return new Promise((resolve, reject) => { const id = ++counter; pending.set(id, {resolve, reject}); browser.stdio[3].write(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}) + '\0'); }); }
async function evaluate(expression) { const result = await cdp('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true}); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const target = await cdp('Target.createTarget', {url: 'about:blank'}, null);
  ({sessionId: session} = await cdp('Target.attachToTarget', {targetId: target.targetId, flatten: true}, null));
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Page.navigate', {url: pathToFileURL(join(directory, 'probe.html')).href});
  await delay(1000);
  {
    async function click(selector, side) {
      const rect = await evaluate(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:${side === 'left' ? 'r.x+2' : side === 'right' ? 'r.right-2' : 'r.x+r.width/2'},y:r.y+r.height/2};})()`);
      await cdp('Input.dispatchMouseEvent', {type:'mousePressed',...rect,button:'left',clickCount:1}); await delay(50);
      await cdp('Input.dispatchMouseEvent', {type:'mouseReleased',...rect,button:'left',clickCount:1}); await delay(100);
      assert.equal(await evaluate('window.view.state.selection.main.head'),0);
      assert.equal(await evaluate('!!document.querySelector("[data-vc-chip]")'),true);
    }
    async function dragValue() {
      const {x,y,width}=await evaluate(`(()=>{const r=document.querySelector('.vaultcrypt-chip-value').getBoundingClientRect();return {x:r.x+1,y:r.y+r.height/2,width:r.width-2};})()`);
      await cdp('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
      for(let i=1;i<=8;i++){await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+width*i/8,y,button:'left',buttons:1});await delay(20);}
      await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:x+width,y,button:'left',clickCount:1});await delay(50);
    }
    for (const attachment of [false,true]) for (const locked of [false,true]) for (const compactChips of [false,true]) {
      await evaluate(`window.reset(${JSON.stringify({attachment,compactChips,table:true,locked})})`);await delay(50);
      for (const side of ['left','right']) await click('[data-vc-chip]',side);
      if (locked) {
        await click('.vaultcrypt-chip-locked > span');
        assert.equal(await evaluate('document.activeElement.parentElement.id'),'mock-unlock');
        await evaluate(`document.querySelector('#mock-unlock').remove()`);
        assert.equal(await evaluate('!!document.querySelector(".vaultcrypt-chip-locked")'),true);
      } else {
        await dragValue();
        assert.equal(await evaluate('document.getSelection().toString()'),attachment?'sample.txt':'sample value');
        await click('[title="Copy to clipboard"]');
        assert.equal(await evaluate('window.copied'),attachment?'sample attachment':'sample value');
        if (!attachment && !compactChips) {
          await dragValue();
          await click('[title="Edit"]');
          assert.equal(await evaluate('document.activeElement.className'),'vaultcrypt-chip-input');
        }
      }
      assert.equal(await evaluate('window.tableActivations'),0,'chip pointerdown must not activate the table cell');
      await click('#table-fixture td','right');
      assert.equal(await evaluate('window.tableActivations'),1,'clicks outside a chip must still reach the table cell');
      console.log(`PASS rendered table chip: attachment=${attachment}, locked=${locked}, compact=${compactChips}`);
    }
  }
} finally {
  const exited = new Promise(resolve => browser.once('exit', resolve));
  await cdp('Browser.close', {}, null).catch(() => browser.kill());
  if (browser.exitCode === null) await exited;
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('vaultcrypt-issue93-')) {
    throw new Error('Refusing to remove a browser profile outside the test temporary directory.');
  }
  await rm(directory, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
}
