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
    import {registerLiveEntryTables} from './src/live-entry-table';
    import {buildCopyTextFromSelection} from './src/clipboard-intercept';
    import {signal, tick} from '@maverick-js/signals';
    let view;
    window.renderErrors = [];
    window.addEventListener('error',event=>window.renderErrors.push(event.message));
    Object.defineProperty(navigator, 'clipboard', {value: {writeText: async text => {window.copied = text;}}});
    window.logs = [];
    window.reset = (options = {}) => {
      if (view) view.destroy();
      document.querySelector('#table-fixture')?.remove();
      window.logs = [];
      const settings = {profiles: {test: {defaultField: 'Password', path: 'test.kdbx'}}, general: {compactChips: false, autoUnmask: true, saveOnBlur: false, ...options}, security: {clipboardClearSeconds: 0}};
      window.copied = null; window.saved = null; window.savedAttachment = null; window.attachmentLookup = null;
      const reference = options.reference ?? ('{{vc:test/entry' + (options.attachment ? '#attachment:sample.txt' : '') + '}}');
      const fieldValue = signal(options.missing || options.missingField ? null : options.empty ? '' : 'sample value');
      window.updateField = value => {fieldValue.set(value);tick();};
      const plugin = {settings, settings$: signal(settings), vaultCryptState: {profiles: []}, vaultCryptState$: signal({profiles: [{id: 'test', isLocked: !!options.locked}]}), sessionService: {isUnlocked: () => !options.locked, getFieldValue: () => fieldValue(), getEntryFields: () => options.missing ? null : ({}), getAttachment: (...args) => {window.attachmentLookup = args;return new TextEncoder().encode('sample attachment');}, getEntryTree: () => null, setFieldValue: async (...args) => {window.saved = args[3];fieldValue.set(args[3]);}}, app: {vault: {getAbstractFileByPath: () => ({}), createBinary: async path => {window.savedAttachment = path;}}}};
      window.copyChipSelection = () => {
        const range=document.createRange();range.selectNode(document.querySelector('[data-vc-chip]'));
        return buildCopyTextFromSelection({rangeCount:1,getRangeAt:()=>range},plugin);
      };
      window.copyMixedSelection = (markup,value='S',selector=null) => {
        const container=document.createElement('div');container.innerHTML=markup;
        container.querySelectorAll('[data-vc-chip]').forEach(chip=>{chip.dataset.vcCopyText=value;});
        const range=document.createRange();range.selectNodeContents(selector?container.querySelector(selector):container);
        return buildCopyTextFromSelection({rangeCount:1,getRangeAt:()=>range},plugin);
      };
      view = new EditorView({parent: document.querySelector('#editor'), state: EditorState.create({doc: 'Before ' + reference + ' after', extensions: [editorLivePreviewField, buildEditorExtension(plugin), EditorView.updateListener.of(update => { if (update.selectionSet) window.logs.push({event: 'CM selection', head: update.state.selection.main.head}); })]})});
      view.focus();
      tick();
      window.view = view;
      window.flushSignals = tick;
      window.unlockProfile = (flushFirst = true) => {
        options.locked = false;
        plugin.vaultCryptState$.set({profiles: [{id: 'test', isLocked: false}]});
        if (flushFirst) tick();
      };
      if (options.table) {
        view.destroy();
        const table = document.createElement('table');table.id='table-fixture';
        const cell=table.insertRow().insertCell();cell.style.padding='12px';cell.textContent='cell ' + reference + ' outside';
        window.tableActivations=0;cell.addEventListener('pointerdown',()=>{window.tableActivations++;});
        document.body.append(table);processVcTokensInDom(table, token=>buildChipElement(token,plugin));tick();
      }
      if (options.liveTable) {
        view.destroy();
        const container = document.createElement('div');
        container.id = 'table-fixture';
        document.body.append(container);
        const names = signal({fields: ['Title', 'Password'], attachments: []});
        plugin.sessionService.getEntryNames = () => plugin.vaultCryptState$().profiles[0].isLocked ? null : names();
        plugin.register = callback => { window.unloadLiveTable = callback; };
        plugin.registerMarkdownCodeBlockProcessor = (language, handler) => {
          if (language !== 'vaultcrypt-table') throw new Error('Unexpected live table language');
          handler('test/entry', container, {addChild: child => child.onload()});
        };
        registerLiveEntryTables(plugin);
        window.initialLiveChip = container.querySelector('[data-vc-chip]');
        window.updateLiveRows = (fields, attachments) => { names.set({fields, attachments}); tick(); };
        window.lockLiveTable = () => {
          options.locked = true;
          plugin.vaultCryptState$.set({profiles: [{id: 'test', isLocked: true}]});
          tick();
        };
        window.liveRowLabels = () => [...container.querySelectorAll('tbody tr td:first-child')].map(cell => cell.textContent);
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
    builder.onResolve({filter: /^\.\/modals(?:\/(?:edit-secret-modal|unlock-modal))?$/}, () => ({path: 'modals', namespace: 'mock'}));
    builder.onLoad({filter: /.*/, namespace: 'mock'}, args => ({contents: args.path === 'host' ? `
      import {StateField} from '@codemirror/state';
      export const editorLivePreviewField = StateField.define({create: () => true, update: value => value});
      export class Menu {} export class Notice {} export class TFile {} export const Platform = {isDesktop: true};
      HTMLElement.prototype.setText = function(text) { this.textContent = text; };
      HTMLElement.prototype.createEl = function(tag, {cls, text, attr} = {}) {
        const el = this.ownerDocument.createElement(tag);
        if (cls) el.className = cls;
        if (text) el.textContent = text;
        for (const [name, value] of Object.entries(attr ?? {})) el.setAttribute(name, value);
        return this.appendChild(el);
      };
      HTMLElement.prototype.createDiv = function(options) { return this.createEl('div', options); };
      HTMLElement.prototype.empty = function() { this.replaceChildren(); };
      export class MarkdownRenderChild {
        cleanups = [];
        constructor(el) { this.containerEl = el; }
        register(callback) { this.cleanups.push(callback); }
        registerDomEvent(el, type, callback) {
          el.addEventListener(type, callback);
          this.register(() => el.removeEventListener(type, callback));
        }
        unload() { this.onunload(); this.cleanups.forEach(cb => cb()); }
      }
    ` : `
      export class UnlockModal {
        constructor(app, plugin, profileId, onDone) {this.profileId=profileId;this.onDone=onDone;}
        open() {
          const modal=document.createElement('div');modal.id='mock-unlock';
          const input=document.createElement('input');modal.append(input);document.body.append(modal);input.focus();
          window.completeUnlock = (flushFirst = true) => {
            window.unlockProfile(flushFirst);modal.remove();this.onDone?.(this.profileId);window.flushSignals();
          };
        }
      }
      export class EditSecretModal {
        constructor(app, plugin, profileId, entryPath, token) {this.reference = {profileId, entryPath, raw: token.raw};}
        open() {window.openedEntry = this.reference;}
      } export class DeleteSecretModal {}
    `, resolveDir: process.cwd()}));
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
let failure;
try {
  const target = await cdp('Target.createTarget', {url: 'about:blank'}, null);
  ({sessionId: session} = await cdp('Target.attachToTarget', {targetId: target.targetId, flatten: true}, null));
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Page.navigate', {url: pathToFileURL(join(directory, 'probe.html')).href});
  await delay(1000);
  {
    const entryPath = 'Client Devices/User 1/Recovery  Keys';
    const filename = 'BitLocker Recovery Key.txt';
    const reference = '{{vc:test/' + entryPath + '#attachment:' + filename + '}}';
    for (const table of [false, true]) {
      await evaluate('window.reset(' + JSON.stringify({table, reference}) + ')');
      assert.equal(await evaluate('document.querySelector("[data-vc-chip]").dataset.vcCopyText'), reference);
      assert.deepEqual(await evaluate('window.attachmentLookup'), ['test', entryPath, filename]);
    }
    console.log('PASS attachment references with spaces render in CodeMirror and post-processed Markdown');
  }
  await evaluate('window.reset({liveTable: true})');
  assert.deepEqual(await evaluate('window.liveRowLabels()'), ['Password']);
  await evaluate('window.updateLiveRows(["Title", "Password", "Api_Key"], ["guide draft.txt"])');
  assert.deepEqual(await evaluate('window.liveRowLabels()'), ['Password', 'Api_Key', 'attachment:guide draft.txt']);
  assert.equal(await evaluate('document.querySelector("#table-fixture [data-vc-chip]") === window.initialLiveChip'), true);
  await evaluate('window.updateField("updated value")');
  assert.equal(await evaluate('window.initialLiveChip.dataset.vcCopyText'), 'updated value');
  await evaluate('window.updateLiveRows(["Password"], [])');
  assert.deepEqual(await evaluate('window.liveRowLabels()'), ['Password']);
  await evaluate('window.lockLiveTable()');
  assert.deepEqual(await evaluate('window.liveRowLabels()'), []);
  assert.equal(await evaluate('document.querySelector("#table-fixture [role=status]").textContent'), 'This profile is locked.');
  await evaluate('window.unlockProfile()');
  assert.deepEqual(await evaluate('window.liveRowLabels()'), ['Password']);
  await evaluate('window.unloadLiveTable(); window.updateLiveRows(["Other"], []);');
  assert.deepEqual(await evaluate('window.liveRowLabels()'), []);
  console.log('PASS live entry table updates rows, preserves active chips, and clears on lock and unload');
  {
    async function click(selector, side) {
      const rect = await evaluate(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:${side === 'left' ? 'r.x+2' : side === 'right' ? 'r.right-2' : 'r.x+r.width/2'},y:r.y+r.height/2};})()`);
      await cdp('Input.dispatchMouseEvent', {type:'mousePressed',...rect,button:'left',clickCount:1}); await delay(50);
      await cdp('Input.dispatchMouseEvent', {type:'mouseReleased',...rect,button:'left',clickCount:1}); await delay(100);
      assert.equal(await evaluate('window.view.state.selection.main.head'),0);
      assert.equal(await evaluate('!!document.querySelector("[data-vc-chip]")'),true);
    }
    async function dragValue(selector = '.vaultcrypt-chip-value') {
      const {x,y,width}=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+1,y:r.y+r.height/2,width:r.width-2};})()`);
      await cdp('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
      for(let i=1;i<=8;i++){await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+width*i/8,y,button:'left',buttons:1});await delay(20);}
      await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:x+width,y,button:'left',clickCount:1});await delay(50);
    }
    for (const [markup,value,expected,selector] of [
      ['A<span data-vc-chip>label</span><br>B','S','AS\nB'],
      ['<p>A<span data-vc-chip>label</span></p><p>B</p>','S','AS\n\nB'],
      ['<p>A<span data-vc-chip>label</span></p>\n<p>B</p>','S','AS\n\nB'],
      ['<div>A<span data-vc-chip>label</span></div><div>B</div>','S','AS\nB'],
      ['<ul><li>A<span data-vc-chip>label</span></li><li>B</li></ul>','S','AS\nB'],
      ['<table><tr><td>A</td><td><span data-vc-chip>label</span></td><td></td></tr><tr><td>B</td><td>C</td><td>D</td></tr></table>','S','A\tS\t\nB\tC\tD'],
      ['<table><tr><td>A</td><td><span data-vc-chip>label</span></td></tr></table>','S','A\tS','tr'],
      ['<table><tr>\n<td>A</td>\n<td><span data-vc-chip>label</span></td>\n</tr></table>','S','A\tS','tr'],
      ['<p><span data-vc-chip>label</span></p>','\nS\n','\nS\n'],
      ['<pre>A\n<span data-vc-chip>label</span>\nB\n</pre>','S','A\nS\nB\n'],
      ['<p>A<span data-vc-chip>label</span></p><p>B</p>','','A\n\nB'],
      ['<p>plain text</p><p>without chips</p>','S',null],
      ['<p>{{vc:test/entry}}</p><p>B</p>','S','{{vc:test/entry}}\n\nB'],
    ]) {
      assert.equal(await evaluate(`window.copyMixedSelection(${JSON.stringify(markup)},${JSON.stringify(value)},${JSON.stringify(selector??null)})`),expected);
    }
    console.log('PASS mixed-content selection preserves line, paragraph and table boundaries');
    for (const table of [false,true]) {
      await evaluate(`window.reset(${JSON.stringify({table})})`);await delay(50);
      await click('[title="Edit"]');
      await evaluate(`(()=>{const input=document.querySelector('.vaultcrypt-chip-input');input.value='saved value';input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));})()`);
      await delay(50);
      assert.equal(await evaluate('window.saved'),'saved value');
      assert.equal(await evaluate('document.querySelector("[title=Edit]").textContent'),'✅');
      await delay(1650);
      assert.equal(await evaluate('document.querySelector("[title=Edit]").textContent'),'✏️');
      await evaluate(`window.updateField('updated after saved indicator')`);
      assert.equal(await evaluate('document.querySelector(".vaultcrypt-chip-value").textContent'),'updated after saved indicator');
      assert.equal(await evaluate('document.querySelector("[title=Edit]").textContent'),'✏️');
      assert.deepEqual(await evaluate('window.renderErrors'),[]);
      console.log(`PASS reactive update after saved indicator expires: table=${table}`);
    }
    for (const table of [false,true]) for (const compactChips of [false,true]) {
      await evaluate(`window.reset(${JSON.stringify({table,compactChips,empty:true})})`);await delay(50);
      assert.equal(await evaluate('document.querySelector(".vaultcrypt-chip-value").textContent'),'(empty)');
      assert.equal(await evaluate('document.querySelector("[data-vc-chip]").dataset.vcCopyText'),'');
      await click('[title="Copy to clipboard"]');
      assert.equal(await evaluate('window.copied'),'');
      if (table) assert.equal(await evaluate('window.tableActivations'),0);
      assert.equal(await evaluate('window.copyChipSelection()'),'','copying an empty chip must not copy its display label');
      console.log(`PASS empty field display and copy: table=${table}, compact=${compactChips}`);
    }
    for (const table of [false,true]) for (const compactChips of [false,true]) for (const missingField of [false,true]) {
      await evaluate(`window.openedEntry=null;window.reset(${JSON.stringify({table,compactChips,missing:!missingField,missingField})})`);await delay(50);
      const text = await evaluate('document.querySelector("[data-vc-chip]").textContent');
      assert.ok(text.includes(missingField?'Field not found: test/entry#Password':'Entry not found: test/entry'));
      assert.equal(text.includes(missingField?'Entry not found':'Field not found'),false);
      await click(missingField?'[title="Add field"]':'[title="Create entry"]');
      assert.deepEqual(await evaluate('window.openedEntry'),{profileId:'test',entryPath:'entry',raw:'{{vc:test/entry}}'});
      if (table) assert.equal(await evaluate('window.tableActivations'),0);
      console.log(`PASS missing ${missingField?'field':'entry'} action: table=${table}, compact=${compactChips}`);
    }
    for (const table of [false,true]) {
      await evaluate(`window.reset(${JSON.stringify({table,attachment:true})})`);await delay(50);
      await click('[title="Expand preview"]');
      await dragValue('.vaultcrypt-preview-code code');
      assert.equal(await evaluate('document.getSelection().toString()'),'sample attachment',
        'expanded attachment preview text must remain selectable');
      assert.equal(await evaluate('getComputedStyle(document.querySelector("[data-vc-chip]")).userSelect'),'none');
      assert.equal(await evaluate('getComputedStyle(document.querySelector(".vaultcrypt-chip-btn")).userSelect'),'none');
      if (table) assert.equal(await evaluate('window.tableActivations'),0);
      await click('[title="Collapse preview"]');
      console.log(`PASS attachment preview selection: table=${table}`);
    }
    for (const table of [false,true]) for (const attachment of [false,true]) for (const autoUnmask of [false,true]) for (const flushFirst of [false,true]) {
      await evaluate(`window.reset(${JSON.stringify({table,attachment,autoUnmask,locked:true})})`);await delay(50);
      await click('.vaultcrypt-chip-locked > span');
      await evaluate(`window.completeUnlock(${flushFirst})`);await delay(50);
      const displayedValue = await evaluate('document.querySelector(".vaultcrypt-chip-value")?.textContent ?? null');
      assert.equal(displayedValue,autoUnmask?(attachment?'sample.txt':'sample value'):null,
        `unlock must honor autoUnmask=${autoUnmask}, table=${table}, attachment=${attachment}, flushFirst=${flushFirst}`);
      assert.equal(await evaluate('!!document.querySelector(".vaultcrypt-chip-locked")'),false);
      if (autoUnmask) {
        await click(attachment?'[title="Mask attachment"]':'[title="Click to mask"]');
        assert.equal(await evaluate('document.querySelector(".vaultcrypt-chip-value")?.textContent ?? null'),null,
          'manually masking an auto-revealed chip must remain possible');
      }
      console.log(`PASS unlock autoUnmask=${autoUnmask}, table=${table}, attachment=${attachment}, flushFirst=${flushFirst}`);
    }
    for (const attachment of [false,true]) for (const locked of [false,true]) for (const compactChips of [false,true]) {
      await evaluate(`window.reset(${JSON.stringify({attachment,compactChips,table:true,locked})})`);await delay(50);
      for (const side of ['left','right']) await click('[data-vc-chip]',side);
      if (locked) {
        await click('.vaultcrypt-chip-locked > span');
        assert.equal(await evaluate('document.activeElement.parentElement.id'),'mock-unlock');
        await evaluate(`document.querySelector('#mock-unlock').remove()`);
        assert.equal(await evaluate('!!document.querySelector(".vaultcrypt-chip-locked")'),true);
        if (!attachment) assert.equal(await evaluate('window.copyChipSelection()'),'[locked]');
      } else {
        await dragValue();
        assert.equal(await evaluate('document.getSelection().toString()'),attachment?'sample.txt':'sample value');
        await click('[title="Copy to clipboard"]');
        assert.equal(await evaluate('window.copied'),attachment?'sample attachment':'sample value');
        if (!attachment) assert.equal(await evaluate('window.copyChipSelection()'),'sample value');
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
} catch (error) {
  failure = error;
}

try {
  const exited = new Promise(resolve => browser.once('exit', resolve));
  await cdp('Browser.close', {}, null).catch(() => browser.kill());
  if (browser.exitCode === null) await exited;
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('vaultcrypt-issue93-')) {
    throw new Error('Refusing to remove a browser profile outside the test temporary directory.');
  }
  await rm(directory, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
} catch (error) {
  if (failure) console.error('Browser cleanup also failed:', error);
  else failure = error;
}
if (failure) throw failure;
