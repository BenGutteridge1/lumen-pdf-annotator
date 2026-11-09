import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';

const output = await build({
  stdin: {
    contents: 'export { openBundle } from "./src/storage"; export * from "./src/annotation-colour";',
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'test-obsidian', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'test' }));
    builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
      contents: 'export class TFile {} export const normalizePath = value => value;', loader: 'js',
    }));
  } }],
});
const { openBundle, resolveAnnotationColour, VaultAnnotationColour, VAULT_ANNOTATION_COLOUR_PATH: preferencePath } =
  await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].contents).toString('base64'));

const [yellow, green, blue, purple, pink] = ['#ffd12d', '#83cb67', '#6f9fe8', '#aa78df', '#e463a1'];
const bytes = content => new TextEncoder().encode(content).buffer;
const file = (path, content) => ({ path, name: path.split('/').at(-1), stat: { size: bytes(content).byteLength, mtime: 123 } });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'lumen-colour-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  function vault() {
    const reads = [], writes = [], processes = [];
    const adapter = {
      async exists(path) {
        try { await stat(join(root, path)); return true; }
        catch (error) { if (error.code === 'ENOENT') return false; throw error; }
      },
      async mkdir(path) { await mkdir(join(root, path)); },
      async read(path) { reads.push(path); return readFile(join(root, path), 'utf8'); },
      async write(path, text) { writes.push(path); await writeFile(join(root, path), text); },
      async process(path, transform) {
        processes.push(path);
        const text = transform(await readFile(join(root, path), 'utf8'));
        await writeFile(join(root, path), text);
        return text;
      },
    };
    return { adapter, reads, writes, processes };
  }
  return { vault, open: (vault, path = 'A.pdf', content = 'Fixture A') => openBundle(vault, file(path, content), bytes(content)) };
}

test('vault default and independent PDF colours survive a new session without per-selection I/O', async t => {
  const data = await fixture(t);
  const firstVault = data.vault();
  const defaults = new VaultAnnotationColour(firstVault);
  await defaults.load();
  const first = await data.open(firstVault);
  const second = await data.open(firstVault, 'B.pdf', 'Fixture B');
  const third = await data.open(firstVault, 'C.pdf', 'Fixture C');
  assert.equal(resolveAnnotationColour(first.annotationColour, defaults), yellow);
  assert.equal(firstVault.writes.filter(path => path === preferencePath).length, 0);
  await first.rememberAnnotationColour(resolveAnnotationColour(first.annotationColour, defaults));
  await second.rememberAnnotationColour(pink);
  await defaults.save(blue);
  assert.equal(resolveAnnotationColour(first.annotationColour, defaults), yellow);
  assert.equal(resolveAnnotationColour(second.annotationColour, defaults), pink);
  assert.equal(resolveAnnotationColour(third.annotationColour, defaults), blue);
  const reads = firstVault.reads.length;
  for (let i = 0; i < 20; i++) {
    assert.equal(resolveAnnotationColour(second.annotationColour, defaults), pink);
    await second.rememberAnnotationColour(pink);
  }
  assert.equal(firstVault.reads.length, reads);
  assert.equal(firstVault.processes.length, 2);
  assert.equal(firstVault.writes.filter(path => path === preferencePath).length, 1);

  const reopenedVault = data.vault();
  const reopenedDefaults = new VaultAnnotationColour(reopenedVault);
  await reopenedDefaults.load();
  const reopened = await Promise.all([
    data.open(reopenedVault),
    data.open(reopenedVault, 'B.pdf', 'Fixture B'),
    data.open(reopenedVault, 'C.pdf', 'Fixture C'),
  ]);
  assert.deepEqual(reopened.map(bundle => resolveAnnotationColour(bundle.annotationColour, reopenedDefaults)), [yellow, pink, blue]);
  assert.equal(reopenedVault.reads.filter(path => path.endsWith('/manifest.json')).length, 3);
  assert.equal(reopenedVault.reads.filter(path => path === preferencePath).length, 1);
  assert.deepEqual(reopenedVault.writes, []);
  assert.deepEqual(reopenedVault.processes, []);
});

test('printed page number preference is stored in shared vault preferences and preserves the vault colour', async t => {
  const data = await fixture(t);
  const firstVault = data.vault();
  const firstDevice = new VaultAnnotationColour(firstVault);
  await firstDevice.load();
  assert.equal(firstDevice.showPrintedPageNumbers, false);
  await firstDevice.save(blue);
  await firstDevice.savePrintedPageNumbers(true);

  const secondDevice = new VaultAnnotationColour(data.vault());
  await secondDevice.load();
  assert.equal(secondDevice.showPrintedPageNumbers, true);
  assert.equal(secondDevice.colour, blue);

  await secondDevice.savePrintedPageNumbers(false);
  const reopenedDevice = new VaultAnnotationColour(data.vault());
  await reopenedDevice.load();
  assert.equal(reopenedDevice.showPrintedPageNumbers, false);
  assert.equal(reopenedDevice.colour, blue);
});

test('same-hash views observe choices immediately and serialized writes preserve rename metadata', async t => {
  const data = await fixture(t);
  const vault = data.vault();
  const [first, other] = await Promise.all([data.open(vault), data.open(vault)]);
  assert.equal(first.annotationColour, other.annotationColour);
  const path = first.folder + '/manifest.json';
  await vault.adapter.process(path, text => JSON.stringify({ ...JSON.parse(text), extra: 'keep me' }));
  vault.processes.length = 0;
  const colours = [];
  const unsubscribe = other.annotationColour.subscribe(() => colours.push(other.annotationColour.colour));
  const firstChoice = first.rememberAnnotationColour(green);
  const moved = data.open(vault, 'Subfolder/Renamed.pdf');
  const nextChoice = other.rememberAnnotationColour(purple);
  const sameChoice = first.rememberAnnotationColour(purple);
  assert.equal(first.annotationColour.colour, purple);
  assert.deepEqual(colours, [green, purple]);
  await Promise.all([firstChoice, moved, nextChoice, sameChoice, first.flushAnnotationColour()]);
  assert.equal(vault.processes.length, 3);
  const manifest = JSON.parse(await vault.adapter.read(path));
  assert.equal(manifest.workingPath, 'Subfolder/Renamed.pdf');
  assert.equal(manifest.originalName, 'Renamed.pdf');
  assert.equal(manifest.lastAnnotationColour, purple);
  assert.equal(manifest.extra, 'keep me');
  unsubscribe();
  await other.rememberAnnotationColour(blue);
  assert.deepEqual(colours, [green, purple]);
});

test('invalid colours fall back and a failed manifest write can retry the same colour', async t => {
  const data = await fixture(t);
  const vault = data.vault();
  const initial = await data.open(vault);
  const path = initial.folder + '/manifest.json';
  await vault.adapter.process(path, text => JSON.stringify({ ...JSON.parse(text), lastAnnotationColour: 'invalid' }));
  await vault.adapter.write(preferencePath, '{ malformed');
  const defaults = new VaultAnnotationColour(vault);
  await defaults.load();
  const reopened = await data.open(vault);
  assert.equal(resolveAnnotationColour(reopened.annotationColour, defaults), yellow);
  const process = vault.adapter.process;
  vault.adapter.process = async () => { throw Error('temporary write failure'); };
  await assert.rejects(reopened.rememberAnnotationColour(green), /temporary write failure/);
  assert.equal(reopened.annotationColour.colour, green);
  vault.adapter.process = process;
  await reopened.rememberAnnotationColour(green);
  assert.equal(JSON.parse(await vault.adapter.read(path)).lastAnnotationColour, green);
});

test('a delayed default reload cannot overwrite a local change and a later vault update is observable', async t => {
  const data = await fixture(t);
  const vault = data.vault();
  const defaults = new VaultAnnotationColour(vault);
  await defaults.save(blue);
  const read = vault.adapter.read;
  let resumeRead, readStarted;
  const started = new Promise(resolve => { readStarted = resolve; });
  vault.adapter.read = async path => {
    const text = await read(path);
    await new Promise(resolve => { resumeRead = resolve; readStarted(); });
    return text;
  };
  const loading = defaults.load();
  await started;
  const saving = defaults.save(pink);
  assert.equal(defaults.colour, pink);
  resumeRead();
  await Promise.all([loading, saving]);
  assert.equal(defaults.colour, pink);
  vault.adapter.read = read;
  await vault.adapter.write(preferencePath, JSON.stringify({ defaultAnnotationColour: purple }));
  let changes = 0;
  defaults.subscribe(() => changes++);
  await defaults.load();
  assert.equal(defaults.colour, purple);
  assert.equal(changes, 1);
});
