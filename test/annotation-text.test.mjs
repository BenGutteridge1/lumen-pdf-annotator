import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

async function bundledModule(entry, stubObsidian = false) {
  const bundle = await build({
    entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022',
    plugins: stubObsidian ? [{
      name: 'test-obsidian',
      setup(builder) {
        builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'test' }));
        builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents: 'export const normalizePath = value => value; export class TFile {}', loader: 'js',
        }));
      },
    }] : [],
  });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
}

const {
  buildQuoteTextRuns, extendAnnotationQuote, extendLegacyQuote, mergeQuoteRanges,
  normalizeQuoteRanges, normalizeQuoteText, quoteFromPageRanges, quoteRangesForSlices,
} = await bundledModule('src/annotation-text.ts');
const { AnnotationIndex } = await bundledModule('src/model.ts');
const { AnnotationRepository } = await bundledModule('src/storage.ts', true);
globalThis.window = globalThis;

function item(str, { x = 10, y = 100, width = str.length * 5, hasEOL = false, dir = 'ltr', transform } = {}) {
  return { str, width, height: 10, transform: transform ?? [10, 0, 0, 10, x, y], hasEOL, dir, fontName: 'test' };
}

function range(start, text) { return { start, end: start + text.length, text }; }
function rect(x = .125, y = .25, width = .5) { return { x, y, width, height: .03125 }; }
function annotation(overrides = {}) {
  return {
    id: 'mark', kind: 'text', page: 1, rects: [rect()], quote: 'who had', note: 'A saved note',
    tags: ['research'], color: '#ffd12d', style: 'underline', createdAt: 123, updatedAt: 456, ...overrides,
  };
}

test('PDF line boundaries restore spaces without splitting adjacent word fragments', () => {
  const runs = buildQuoteTextRuns([
    item('who', { hasEOL: true }), item('had', { y: 88 }),
    item('final', { x: 28, y: 88 }), item('ly', { x: 53, y: 88 }),
  ]);
  const ranges = quoteRangesForSlices(runs, runs.map((run, index) => ({ index, start: 0, end: run.text.length })));
  assert.equal(quoteFromPageRanges(new Map([[1, ranges]])), 'who had finally');
  assert.deepEqual(ranges, [range(0, 'who had finally')]);
});

test('empty EOL items, geometric line changes and word gaps keep stable source offsets', () => {
  const runs = buildQuoteTextRuns([
    item('hello'), item('', { hasEOL: true }), item('world'),
    item('next', { y: 86 }), item('word', { x: 33, y: 86 }),
  ]);
  assert.equal(runs.map(run => run.separatorBefore + run.text).join(''), 'hello world next word');
  for (const run of runs) assert.equal(run.end - run.start, run.text.length);
  const rotated = buildQuoteTextRuns([
    item('up', { transform: [0, 10, -10, 0, 100, 10], hasEOL: false }),
    item('line', { transform: [0, 10, -10, 0, 88, 10] }),
  ]);
  assert.equal(rotated[1].separatorBefore, ' ');
});

test('selection offsets clip original characters before safe ligature expansion', () => {
  const runs = buildQuoteTextRuns([item('preﬁx'), item('later', { y: 88 })]);
  const ranges = quoteRangesForSlices(runs, [{ index: 0, start: 3, end: 5 }, { index: 1, start: 0, end: 3 }]);
  assert.deepEqual(ranges, [range(3, 'ﬁx lat')]);
  assert.equal(quoteFromPageRanges(new Map([[1, ranges]])), 'fix lat');
  assert.equal(normalizeQuoteText('ﬀ ﬁ ﬂ ﬃ ﬄ ﬅ ﬆ x² 𝑥 ①'), 'ff fi fl ffi ffl st st x² 𝑥 ①');
});

test('RTL gaps use the text direction and vertical glyph advances are not word spaces', () => {
  const rtl = buildQuoteTextRuns([
    item('אב', { x: 40, width: 10, dir: 'rtl' }),
    item('גד', { x: 28, width: 10, dir: 'rtl' }),
  ]);
  assert.equal(rtl[1].separatorBefore, ' ');
  const vertical = buildQuoteTextRuns([
    item('漢', { x: 40, y: 100, dir: 'ttb' }), item('字', { x: 40, y: 90, dir: 'ttb' }),
  ]);
  assert.equal(vertical[1].separatorBefore, '');
});

test('unmapped PDF glyphs are visible and never inferred from surrounding words', () => {
  assert.equal(normalizeQuoteText('had \u0000nally; su\u0000cient; e\u0000orts'), 'had �nally; su�cient; e�orts');
  assert.equal(normalizeQuoteText('  line\n\tbreak  '), 'line break');
});

test('range union removes true overlap but preserves repeated text at different offsets', () => {
  assert.deepEqual(mergeQuoteRanges([range(4, 'had finally'), range(0, 'who had'), range(4, 'had')]), [range(0, 'who had finally')]);
  assert.deepEqual(mergeQuoteRanges([range(0, 'the'), range(8, 'the')]), [range(0, 'the'), range(8, 'the')]);
  assert.equal(mergeQuoteRanges([range(0, 'alpha'), range(2, 'oops')]), null);
});

test('repeated, disjoint, before and after extensions follow page text offsets', () => {
  let member = annotation({ quote: 'third', quoteRanges: [range(20, 'third')] });
  for (const selected of [range(0, 'first'), range(10, 'second'), range(30, 'fourth'), range(10, 'second')]) {
    const result = extendAnnotationQuote([member], member.quote, selected.text, new Map([[1, [rect()]]]), new Map([[1, [selected]]]));
    member = { ...member, quote: result.quote, quoteRanges: result.rangesByPage.get(1) };
  }
  assert.equal(member.quote, 'first second third fourth');
  assert.equal(member.quoteRanges.length, 4);
});

test('overlapping extensions on both sides reconstruct the selected source only once', () => {
  const member = annotation({ quote: 'had', quoteRanges: [range(4, 'had')] });
  const result = extendAnnotationQuote([member], member.quote, 'who had finally', new Map([[1, [rect()]]]), new Map([[1, [range(0, 'who had finally')]]]));
  assert.equal(result.quote, 'who had finally');
  assert.deepEqual(result.rangesByPage.get(1), [range(0, 'who had finally')]);
});

test('cross-page ranges assemble in document order with overlap confined to each page', () => {
  const members = [
    annotation({ page: 3, quote: 'second third', quoteRanges: [range(0, 'third')] }),
    annotation({ id: 'first', page: 2, quote: 'second third', quoteRanges: [range(30, 'second')] }),
  ];
  const result = extendAnnotationQuote(members, 'second third', 'first second fourth',
    new Map([[3, [rect()]], [1, [rect()]], [2, [rect()]]]),
    new Map([[3, [range(10, 'fourth')]], [1, [range(40, 'first')]], [2, [range(30, 'second')]]]));
  assert.equal(result.quote, 'first second third fourth');
  assert.equal(result.rangesByPage.size, 3);
});

test('old annotations prepend/append by page and position, preserving identical disjoint words', () => {
  const member = annotation({ quote: 'had', rects: [rect(.3, .3, .1)] });
  assert.equal(extendLegacyQuote('had', 'who', [member], new Map([[1, [rect(.1, .2)]]])), 'who had');
  assert.equal(extendLegacyQuote('had', 'finally', [member], new Map([[1, [rect(.1, .4)]]])), 'had finally');
  assert.equal(extendLegacyQuote('had', 'before', [member], new Map([[0, [rect()]]])), 'before had');
  assert.equal(extendLegacyQuote('had', 'after', [member], new Map([[2, [rect()]]])), 'had after');
  assert.equal(extendLegacyQuote('had', 'had', [member], new Map([[1, [rect(.1, .4)]]])), 'had had');
});

test('old overlapping extensions combine boundary text and safely handle long repeated quotes', () => {
  const member = annotation({ quote: 'who had', rects: [rect(.1, .3, .4)] });
  assert.equal(extendLegacyQuote('who had', 'had finally', [member], new Map([[1, [rect(.3, .3, .4)]]])), 'who had finally');
  assert.equal(extendLegacyQuote('had finally', 'who had', [member], new Map([[1, [rect(.05, .3, .4)]]])), 'who had finally');
  assert.equal(extendLegacyQuote('who had', 'who had finally', [member], new Map([[1, [rect(.1, .3, .7)]]])), 'who had finally');
  const long = 'a'.repeat(100_000);
  assert.equal(extendLegacyQuote(`x${long}`, `${long}y`, [member], new Map([[1, [rect(.3, .3, .4)]]])), `x${long}y`);
});

test('stale or incomplete optional anchors never replace a saved legacy quote', () => {
  const member = annotation({ quote: 'who had more', quoteRanges: [range(0, 'who had')] });
  const result = extendAnnotationQuote([member], member.quote, 'finally', new Map([[2, [rect()]]]), new Map([[2, [range(0, 'finally')]]]));
  assert.deepEqual(result, { quote: 'who had more finally' });
  const missing = extendAnnotationQuote([annotation()], 'who had', 'finally', new Map([[2, [rect()]]]), new Map());
  assert.deepEqual(missing, { quote: 'who had finally' });
});

test('range validation rejects corrupt optional data without accepting unsafe offsets', () => {
  for (const invalid of [null, [], [{}], [range(-1, 'word')], [range(.5, 'word')],
    [{ start: 1, end: 2, text: 'long' }], [{ start: 0, end: Number.MAX_SAFE_INTEGER + 1, text: 'x' }],
    [range(0, 'abc'), range(1, 'wrong')]]) assert.equal(normalizeQuoteRanges(invalid), undefined);
  assert.deepEqual(normalizeQuoteRanges([range(7, 'had'), range(0, 'who')]), [range(0, 'who'), range(7, 'had')]);
});

function memoryVault(files = {}) {
  const data = new Map(Object.entries(files));
  return { data, vault: { adapter: {
    async exists(path) { return data.has(path); },
    async read(path) { if (!data.has(path)) throw new Error(`Missing ${path}`); return data.get(path); },
    async write(path, text) { data.set(path, text); },
    async append(path, text) { data.set(path, (data.get(path) ?? '') + text); },
  } } };
}

test('old compact snapshots and journals retain every annotation field without adding anchors', async () => {
  const old = annotation();
  const pageNote = annotation({ id: 'page-note', kind: 'page-note', quote: 'Page note', style: 'comment' });
  const changed = { ...old, quote: 'had nally', note: 'An old spelling stays intact', updatedAt: 789 };
  const { vault } = memoryVault({
    'bundle/annotations.snapshot.json': JSON.stringify([old, pageNote]),
    'bundle/annotations.journal.jsonl': JSON.stringify({ op: 'put', annotation: changed }) + '\n',
  });
  const repository = new AnnotationRepository(vault, 'bundle', 'hash', 'Document.pdf');
  const restored = await repository.load();
  assert.deepEqual(JSON.parse(JSON.stringify(restored.get(old.id))), changed);
  assert.deepEqual(JSON.parse(JSON.stringify(restored.get(pageNote.id))), pageNote);
  assert.equal(Object.hasOwn(restored.get(old.id), 'quoteRanges'), false);
});

test('old Markdown snapshots still load and remain unchanged when checkpointed', async () => {
  const old = annotation({ id: 'markdown', quote: 'whohad and had nally' });
  const { vault, data } = memoryVault({ 'bundle/annotations.md': '```json lumen-pdf-data\n' + JSON.stringify([old]) + '\n```' });
  const repository = new AnnotationRepository(vault, 'bundle', 'hash', 'Document.pdf');
  const index = await repository.load();
  assert.equal(index.size, 1);
  await repository.checkpoint(index);
  assert.deepEqual(JSON.parse(data.get('bundle/annotations.snapshot.json')), [old]);
});

test('new ranges and logical group identity round-trip through journal and checkpoints', async () => {
  const first = annotation({ groupId: 'mark', quote: 'who had finally', quoteRanges: [range(0, 'who had')] });
  const second = annotation({ id: 'continuation', groupId: 'mark', page: 2, quote: first.quote, quoteRanges: [range(20, 'ﬁnally')] });
  // Visible normalization expands the source ligature without changing stored offsets.
  const { vault, data } = memoryVault();
  let repository = new AnnotationRepository(vault, 'bundle', 'hash', 'Document.pdf');
  const index = new AnnotationIndex();
  for (const member of [first, second]) { index.put(member); repository.queue({ op: 'put', annotation: member }); }
  await repository.flushJournal();
  repository = new AnnotationRepository(vault, 'bundle', 'hash', 'Document.pdf');
  const restored = await repository.load();
  assert.equal(restored.logicalSize, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(restored.inGroup('mark'))), [first, second]);
  await repository.checkpoint(restored);
  assert.equal(data.get('bundle/annotations.journal.jsonl'), '');
  const checkpointed = await new AnnotationRepository(vault, 'bundle', 'hash', 'Document.pdf').load();
  assert.deepEqual(JSON.parse(JSON.stringify(checkpointed.inGroup('mark'))), [first, second]);
  assert.equal(quoteFromPageRanges(new Map(checkpointed.inGroup('mark').map(member => [member.page, member.quoteRanges]))), first.quote);
});

test('invalid optional ranges do not discard annotations from storage', async () => {
  const valid = annotation();
  const damaged = { ...valid, quoteRanges: [{ start: -1, end: 10, text: 'wrong' }] };
  const { vault } = memoryVault({ 'bundle/annotations.snapshot.json': JSON.stringify([damaged]) });
  const index = await new AnnotationRepository(vault, 'bundle', 'hash', 'Document.pdf').load();
  assert.deepEqual(JSON.parse(JSON.stringify(index.get(valid.id))), valid);
});
