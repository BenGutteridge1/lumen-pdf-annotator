import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: 'export { AnnotationSearchIndex, ANNOTATION_SEARCH_FOLDER } from "./src/annotation-search-index"; export { AnnotationIndex } from "./src/model"; export { TFile, TFolder } from "obsidian";',
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022',
  plugins: [{
    name: 'test-obsidian',
    setup(builder) {
      builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'test' }));
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
        contents: 'export class TFile { constructor(path) { this.path = path; this.name = path.split("/").at(-1); } } export class TFolder { constructor(path) { this.path = path; this.children = []; } } export const normalizePath = value => value;',
        loader: 'js',
      }));
    },
  }],
});
const { AnnotationSearchIndex, ANNOTATION_SEARCH_FOLDER, AnnotationIndex, TFile, TFolder } =
  await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'));

globalThis.window = {
  setTimeout: (callback, delay) => setTimeout(callback, Math.min(delay, 5)),
  clearTimeout,
};

const hash = 'a'.repeat(64);

function annotation(id, overrides = {}) {
  return {
    id, kind: 'text', page: 4, rects: [{ x: .1, y: .2, width: .3, height: .04 }],
    quote: 'special search phrase', note: 'research observation', tags: ['review'],
    color: '#ffd12d', style: 'highlight', createdAt: 10, updatedAt: 20, ...overrides,
  };
}

class VaultFixture {
  constructor() {
    this.folders = new Map();
    this.files = new Map();
    this.hidden = new Map();
    this.created = 0;
    this.modified = 0;
    this.deleted = 0;
    this.adapter = {
      exists: async path => this.hidden.has(path) || this.files.has(path) || this.folders.has(path),
      read: async path => this.hidden.get(path) ?? this.files.get(path)?.content,
      list: async path => ({
        folders: [...this.folders.keys()].filter(folder => folder.startsWith(path + '/') && !folder.slice(path.length + 1).includes('/')),
        files: [],
      }),
    };
  }
  getName() { return 'Tester'; }
  getAbstractFileByPath(path) { return this.folders.get(path) ?? this.files.get(path)?.file ?? null; }
  async createFolder(path) {
    const folder = new TFolder(path);
    this.folders.set(path, folder);
    return folder;
  }
  async create(path, content) {
    const file = new TFile(path);
    this.files.set(path, { file, content });
    this.folders.get(path.slice(0, path.lastIndexOf('/')))?.children.push(file);
    this.created++;
    return file;
  }
  async read(file) { return this.files.get(file.path)?.content; }
  async modify(file, content) {
    this.files.get(file.path).content = content;
    this.modified++;
  }
  async delete(file) {
    if (file instanceof TFolder) {
      assert.equal(file.children.length, 0);
      this.folders.delete(file.path);
      this.deleted++;
      return;
    }
    this.files.delete(file.path);
    const children = this.folders.get(file.path.slice(0, file.path.lastIndexOf('/')))?.children;
    if (children) children.splice(children.indexOf(file), 1);
    this.deleted++;
  }
  generated() {
    return [...this.files].filter(([path]) => path.startsWith(ANNOTATION_SEARCH_FOLDER + '/'));
  }
}

function source(index, pdfPath = 'Books/Example.pdf') {
  return { hash, folder: '.lumen-pdf/bundles/sha256/' + hash, pdfPath, index, flush: async () => undefined };
}

function host(vault) {
  return { vault, fileManager: { trashFile: file => vault.delete(file) } };
}

async function settle() {
  await new Promise(resolve => setTimeout(resolve, 30));
}

test('indexing is inert until enabled, then creates removable searchable notes', async () => {
  const vault = new VaultFixture();
  const index = new AnnotationIndex();
  index.put(annotation('first'));
  index.put(annotation('underscored', { quote: 'CEDAR_MAPLE_TOKEN' }));
  const service = new AnnotationSearchIndex(host(vault), () => [source(index)], false);
  service.start();
  service.schedule(source(index));
  await settle();
  assert.equal(vault.generated().length, 0);
  await service.setEnabled(true);
  const [path, file] = vault.generated()[0];
  assert.match(path, /Lumen-Example--a{16}--0001\.md$/);
  assert.match(file.content, /special search phrase/);
  assert.match(file.content, /research observation/);
  assert.match(file.content, /CEDAR_MAPLE_TOKEN/);
  assert.doesNotMatch(file.content, /CEDAR\\_MAPLE/);
  assert.match(file.content, /obsidian:\/\/lumen-pdf\?vault=Tester&file=Books%2FExample\.pdf&annotation=first/);
  await service.setEnabled(false);
  assert.equal(vault.generated().length, 0);
  assert.equal(vault.folders.has(ANNOTATION_SEARCH_FOLDER), false);
  assert.equal(index.get('first').note, 'research observation');
  service.dispose();
});

test('existing snapshot and journal annotations become searchable without opening a PDF', async () => {
  const vault = new VaultFixture();
  const folder = '.lumen-pdf/bundles/sha256/' + hash;
  vault.folders.set('.lumen-pdf/bundles/sha256', new TFolder('.lumen-pdf/bundles/sha256'));
  vault.folders.set(folder, new TFolder(folder));
  vault.hidden.set(folder + '/manifest.json', JSON.stringify({
    version: 1, sha256: hash, workingPath: 'Archive/Old.pdf', originalName: 'Old.pdf', updatedAt: '2026-01-01',
  }));
  vault.hidden.set(folder + '/annotations.snapshot.json', JSON.stringify([annotation('saved', { quote: 'old saved highlight' })]));
  vault.hidden.set(folder + '/annotations.journal.jsonl',
    JSON.stringify({ op: 'put', annotation: annotation('added', { note: 'journal note' }) }) + '\n');
  const service = new AnnotationSearchIndex(host(vault), () => [], false);
  await service.setEnabled(true);
  const text = vault.generated().map(([, file]) => file.content).join('\n');
  assert.match(text, /old saved highlight/);
  assert.match(text, /journal note/);
  assert.equal(vault.hidden.get(folder + '/annotations.journal.jsonl').includes('journal note'), true);
  service.dispose();
});

test('cross-page highlights stay grouped and page notes include their note text', async () => {
  const vault = new VaultFixture();
  const index = new AnnotationIndex();
  index.put(annotation('group', { groupId: 'group', page: 2, quote: 'first-page words', note: 'one grouped note' }));
  index.put(annotation('group-3', { groupId: 'group', page: 3, quote: 'second-page words', note: 'one grouped note' }));
  index.put(annotation('page-note', { kind: 'page-note', page: 4, quote: 'Page note', note: 'margin observation' }));
  const service = new AnnotationSearchIndex(host(vault), () => [source(index)], false);
  await service.setEnabled(true);
  const text = vault.generated()[0][1].content;
  assert.match(text, /first-page words/);
  assert.match(text, /second-page words/);
  assert.equal(text.match(/one grouped note/g)?.length, 1);
  assert.match(text, /margin observation/);
  assert.equal(text.match(/annotation=group\b/g)?.length, 3);
  service.dispose();
});

test('a colliding handwritten note is never overwritten', async () => {
  const vault = new VaultFixture();
  const index = new AnnotationIndex();
  index.put(annotation('first'));
  await vault.createFolder(ANNOTATION_SEARCH_FOLDER);
  const path = ANNOTATION_SEARCH_FOLDER + '/Lumen-Example--' + hash.slice(0, 16) + '--0001.md';
  await vault.create(path, 'My handwritten note');
  let failures = 0;
  const service = new AnnotationSearchIndex(host(vault), () => [source(index)], false, () => failures++);
  const log = console.error;
  console.error = () => undefined;
  try { await service.setEnabled(true); }
  finally { console.error = log; }
  assert.equal(vault.files.get(path).content, 'My handwritten note');
  assert.equal(failures, 1);
  service.dispose();
});

test('two PDF panes merge their persisted changes before the search copy updates', async () => {
  const vault = new VaultFixture();
  const folder = '.lumen-pdf/bundles/sha256/' + hash;
  vault.folders.set('.lumen-pdf/bundles/sha256', new TFolder('.lumen-pdf/bundles/sha256'));
  vault.folders.set(folder, new TFolder(folder));
  vault.hidden.set(folder + '/manifest.json', JSON.stringify({
    version: 1, sha256: hash, workingPath: 'Books/Example.pdf', originalName: 'Example.pdf', updatedAt: '2026-01-01',
  }));
  vault.hidden.set(folder + '/annotations.snapshot.json', JSON.stringify([annotation('base')]));
  vault.hidden.set(folder + '/annotations.journal.jsonl', '');
  const first = new AnnotationIndex();
  const second = new AnnotationIndex();
  first.put(annotation('base'));
  second.put(annotation('base'));
  first.put(annotation('from-first', { quote: 'first pane phrase' }));
  second.put(annotation('from-second', { quote: 'second pane phrase' }));
  const views = [first, second].map((index, position) => ({
    ...source(index),
    flush: async () => {
      const key = position === 0 ? 'from-first' : 'from-second';
      vault.hidden.set(folder + '/annotations.journal.jsonl',
        vault.hidden.get(folder + '/annotations.journal.jsonl')
          + JSON.stringify({ op: 'put', annotation: index.get(key) }) + '\n');
    },
  }));
  const service = new AnnotationSearchIndex(host(vault), () => views, false);
  await service.setEnabled(true);
  const text = vault.generated()[0][1].content;
  assert.match(text, /first pane phrase/);
  assert.match(text, /second pane phrase/);
  service.dispose();
});

test('edits coalesce, deleted annotations leave no stale chunk, and unrelated notes survive', async () => {
  const vault = new VaultFixture();
  const index = new AnnotationIndex();
  for (let n = 0; n < 201; n++) index.put(annotation('item-' + n, { quote: 'quote-' + n }));
  const service = new AnnotationSearchIndex(host(vault), () => [source(index)], false);
  await service.setEnabled(true);
  assert.equal(vault.generated().length, 2);
  assert.equal(vault.created, 2);
  index.put(annotation('item-200', { quote: 'revised phrase' }));
  service.schedule(source(index));
  service.schedule(source(index));
  await settle();
  assert.equal(vault.modified, 1);
  assert.match(vault.generated()[1][1].content, /revised phrase/);
  index.remove('item-200');
  service.schedule(source(index));
  await settle();
  assert.equal(vault.generated().length, 1);
  assert.equal(vault.generated()[0][1].content.includes('revised phrase'), false);
  await vault.create(ANNOTATION_SEARCH_FOLDER + '/Personal.md', 'A note owned by the user');
  await service.setEnabled(false);
  assert.deepEqual(vault.generated().map(([path]) => path), [ANNOTATION_SEARCH_FOLDER + '/Personal.md']);
  assert.equal(vault.folders.has(ANNOTATION_SEARCH_FOLDER), true);
  service.dispose();
});
