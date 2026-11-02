import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const result = await build({ entryPoints:['src/toolbar-state.ts'], bundle:true, write:false, platform:'node', format:'esm', target:'es2022' });
const { PdfToolbarStateStore } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
const first = 'a'.repeat(64), second = 'b'.repeat(64), third = 'c'.repeat(64);
function storage() {
  const data = new Map();
  let writes = 0;
  return { data, get writes() { return writes; }, getItem:key=>data.get(key)??null, setItem:(key,value)=>{ data.set(key,value); writes++; } };
}

test('first-open defaults persist immediately and explicit expanded/collapsed choices survive reload', () => {
  const local = storage();
  const original = new PdfToolbarStateStore('Research vault', local);
  assert.equal(original.resolve(first, true), true);
  assert.equal(original.resolve(second, false), false);
  assert.equal(local.writes, 2);
  original.save(first, false);
  original.save(second, true);
  assert.equal(local.writes, 4, 'toggle saves synchronously, without an unload or debounce');
  const reloaded = new PdfToolbarStateStore('Research vault', local);
  assert.equal(reloaded.resolve(first, true), false, 'saved false overrides a collapsed default');
  assert.equal(reloaded.resolve(second, false), true, 'saved true overrides an expanded default');
  assert.equal(local.writes, 4, 'reopening and changed defaults never rewrite overrides');
});

test('PDF identity follows content across rename while separate PDFs and vaults keep their own states', () => {
  const local = storage();
  const view = new PdfToolbarStateStore('One', local);
  assert.equal(view.resolve(first, false), false);
  assert.equal(view.resolve(second, true), true);
  assert.equal(new PdfToolbarStateStore('One', local).resolve(first, true), false, 'a renamed PDF has the same content hash');
  assert.equal(new PdfToolbarStateStore('Two', local).resolve(first, true), true);
  assert.equal(new PdfToolbarStateStore('One', storage()).resolve(first, true), true, 'another device is independent');
});

test('a PDF left at its initial default keeps that state after the default changes and Obsidian reloads', () => {
  const local = storage();
  assert.equal(new PdfToolbarStateStore('Vault', local).resolve(first, true), true);
  assert.equal(new PdfToolbarStateStore('Vault', local).resolve(first, false), true);
  assert.equal(local.writes, 1);
});

test('multiple readers merge fresh device-local values without losing another PDF choice', () => {
  const local = storage();
  const left = new PdfToolbarStateStore('Vault', local), right = new PdfToolbarStateStore('Vault', local);
  left.save(first, true); right.save(second, false); left.save(third, true);
  const reloaded = new PdfToolbarStateStore('Vault', local);
  assert.deepEqual([reloaded.resolve(first,false),reloaded.resolve(second,true),reloaded.resolve(third,false)],[true,false,true]);
});

test('legacy absence uses the selected default without touching old zoom settings', () => {
  const local = storage();
  const zoomKey = 'lumen-pdf-annotator:pdf-view-state:v1:Vault';
  const zoom = JSON.stringify({version:1,pdfs:{'mobile:Example.pdf':{zoom:1.25,mobileFit:false}}});
  local.data.set(zoomKey, zoom);
  const store = new PdfToolbarStateStore('Vault', local);
  assert.equal(store.resolve(first, false), false);
  assert.equal(store.resolve(second, true), true);
  assert.equal(local.data.get(zoomKey), zoom);
});

test('invalid stored values cannot turn an explicit false into a default', () => {
  const local = storage();
  const key = 'lumen-pdf-annotator:mobile-toolbar:v1:Vault';
  local.data.set(key, JSON.stringify({version:1,pdfs:{[first]:false,[second]:'false',[third]:true,invalid:true}}));
  const store = new PdfToolbarStateStore('Vault', local);
  assert.equal(store.resolve(first,true), false);
  assert.equal(store.resolve(second,true), true);
  assert.equal(store.resolve(third,false), true);
  assert.equal(Object.hasOwn(JSON.parse(local.data.get(key)).pdfs,'invalid'),false);
});

test('unavailable storage retains per-PDF preferences for the current session', () => {
  const store = new PdfToolbarStateStore('Vault', null);
  store.save(first, false);
  assert.equal(store.resolve(first,true),false);
  assert.equal(store.resolve(second,true),true);
});
