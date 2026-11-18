import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson } from '../src/storage.js';
import { validateInput, fingerprints, analyzeRebuild, rebuildPlan, hash, requestFor, KEY_FORMAT, POLICY_HASH } from '../src/model.js';
import { step, exportAnalysis } from '../src/engine.js';
import { mockApi, CONFIG, ROOM_CODE, id } from '../src/mock.js';

const fixture = await readJson(new URL('../examples/build.json', import.meta.url));
const example = () => structuredClone(fixture);
const choices = (input, choice = 'require') => Object.fromEntries(input.targets.map(target => [target.id, choice]));
const keyMap = input => Object.fromEntries(fingerprints(input).tasks.map(row => [row.taskId, row.key]));
const h = n => n.toString(16).padStart(64, '0');
function recursiveKeys(input) {
  const result = new Map();
  function visit(id) {
    if (result.has(id)) return result.get(id);
    const task = input.tasks.find(task => task.id === id);
    const dependencies = [...task.dependencies].sort().map(id => ({ id, key: visit(id) }));
    const sources = [...task.sourceIds].sort().map(id => ({ id, sha256: input.sources.find(source => source.id === id).sha256 }));
    const serialized = `{"dependencies":${JSON.stringify(dependencies)},"environmentHash":${JSON.stringify(task.environmentHash)},"format":"pingroom-task-key-v1","recipeHash":${JSON.stringify(task.recipeHash)},"sources":${JSON.stringify(sources)},"taskId":${JSON.stringify(id)}}`;
    const key = createHash('sha256').update(serialized, 'utf8').digest('hex'); result.set(id, key); return key;
  }
  for (const task of input.tasks) visit(task.id);
  return result;
}
function neededClosure(input, selected, hitIds) {
  const needed = new Set(input.targets.filter(target => selected[target.id] === 'require').map(target => target.taskId));
  let changed;
  do {
    changed = false;
    for (const task of input.tasks) if (needed.has(task.id) && !hitIds.has(task.id)) for (const dependency of task.dependencies) if (!needed.has(dependency)) { needed.add(dependency); changed = true; }
  } while (changed);
  return [...needed].sort();
}

test('canonical task keys agree with independent recursive fixed-schema serialization', () => {
  const input = example(), expected = recursiveKeys(input), actual = fingerprints(input);
  assert.equal(actual.keyFormat, KEY_FORMAT);
  for (const row of actual.tasks) assert.equal(row.key, expected.get(row.taskId));
  assert.equal(actual.tasks[0].preimage.format, 'pingroom-task-key-v1');
  assert.deepEqual(actual.tasks.map(row => row.taskId), ['base', 'catalog', 'pages']);
});

test('4096 bounded DAG, cache-hit and target combinations match independent needed-closure oracle', () => {
  const edges = [[1, 0], [2, 0], [2, 1], [3, 0], [3, 1], [3, 2]];
  let cases = 0;
  for (let graph = 0; graph < 64; graph++) {
    const input = { buildId: 'oracle', title: 'Oracle', sources: [{ id: 'data', sha256: h(1) }], tasks: Array.from({ length: 4 }, (_, i) => ({ id: `t${i}`, recipeHash: h(10 + i), environmentHash: h(20), sourceIds: i === 0 ? ['data'] : [], dependencies: edges.filter(([from], bit) => from === i && (graph & (1 << bit))).map(([, to]) => `t${to}`) })), cache: [], targets: [{ id: 'two', label: 'Two', taskId: 't2' }, { id: 'three', label: 'Three', taskId: 't3' }] };
    const expectedKeys = recursiveKeys(input);
    for (const row of fingerprints(input).tasks) assert.equal(row.key, expectedKeys.get(row.taskId));
    for (let hitMask = 0; hitMask < 16; hitMask++) for (let requested = 0; requested < 4; requested++) {
      const hits = new Set(input.tasks.filter((_, i) => hitMask & (1 << i)).map(task => task.id));
      input.cache = [...hits].map(taskId => ({ taskId, key: expectedKeys.get(taskId), artifactPresent: true }));
      const selected = { two: requested & 1 ? 'require' : 'skip', three: requested & 2 ? 'require' : 'skip' };
      const expected = neededClosure(input, selected, hits), result = analyzeRebuild(input, selected);
      assert.deepEqual(result.steps.map(row => row.taskId).sort(), expected);
      assert.deepEqual([...result.rebuildTaskIds].sort(), expected.filter(taskId => !hits.has(taskId)));
      assert.deepEqual([...result.reusedTaskIds].sort(), expected.filter(taskId => hits.has(taskId)));
      assert.equal(new Set(result.steps.map(row => row.taskId)).size, result.steps.length);
      const positions = new Map(result.steps.map((row, index) => [row.taskId, index]));
      for (const task of input.tasks) if (result.rebuildTaskIds.includes(task.id)) for (const dependency of task.dependencies) assert.ok(positions.get(dependency) < positions.get(task.id));
      for (const task of result.tasks) assert.equal(task.execution === 'not_requested', !expected.includes(task.taskId));
      cases++;
    }
  }
  assert.equal(cases, 4096);
});

test('a valid requested target hit prunes absent and artifact-missing ancestors', () => {
  const input = example(), keys = keyMap(input);
  input.cache = [{ taskId: 'base', key: keys.base, artifactPresent: false }, { taskId: 'pages', key: keys.pages, artifactPresent: true }];
  const result = analyzeRebuild(input, { catalog: 'skip', pages: 'require' });
  assert.deepEqual(result.rebuildTaskIds, []); assert.deepEqual(result.reusedTaskIds, ['pages']); assert.deepEqual(result.neededSourceIds, []);
  assert.equal(result.tasks.find(row => row.taskId === 'base').cacheStatus, 'artifact_missing');
  assert.equal(result.tasks.find(row => row.taskId === 'base').execution, 'not_requested');
  assert.equal(result.noRebuildRequired, true); assert.equal(result.nothingRequested, false);
});

test('shared dependencies rebuild once before both required outputs; cached dependencies stop traversal', () => {
  const input = example();
  let result = analyzeRebuild(input, choices(input));
  assert.deepEqual(result.rebuildTaskIds, ['base', 'catalog', 'pages']); assert.deepEqual(result.neededSourceIds, ['data', 'style']);
  input.cache = [{ taskId: 'base', key: keyMap(input).base, artifactPresent: true }];
  result = analyzeRebuild(input, choices(input));
  assert.deepEqual(result.reusedTaskIds, ['base']); assert.deepEqual(result.rebuildTaskIds, ['catalog', 'pages']); assert.deepEqual(result.neededSourceIds, ['style']);
});

test('cache miss reasons distinguish absent records, key mismatch and declared artifact loss', () => {
  const input = example(), keys = keyMap(input);
  input.cache = [{ taskId: 'base', key: h(99), artifactPresent: false }, { taskId: 'catalog', key: keys.catalog, artifactPresent: false }];
  const result = analyzeRebuild(input, choices(input));
  assert.deepEqual(result.steps.map(row => row.reason), ['key_mismatch', 'artifact_missing', 'absent_record']);
  assert.equal(result.steps[0].previousKey, h(99)); assert.equal(result.steps[0].expectedKey, keys.base); assert.equal(result.steps[2].previousKey, null);
});

test('source, recipe and environment changes invalidate every transitive consumer', () => {
  const initial = example(), before = keyMap(initial);
  for (const mutate of [x => { x.sources[0].sha256 = h(80); }, x => { x.tasks[0].recipeHash = h(81); }, x => { x.tasks[0].environmentHash = h(82); }]) {
    const input = example(); input.cache = Object.entries(before).map(([taskId, key]) => ({ taskId, key, artifactPresent: true })); mutate(input);
    const after = keyMap(input); for (const taskId of Object.keys(before)) assert.notEqual(after[taskId], before[taskId]);
    assert.deepEqual(analyzeRebuild(input, choices(input)).steps.map(row => row.reason), ['key_mismatch', 'key_mismatch', 'key_mismatch']);
  }
  const leaf = example(); leaf.tasks.find(task => task.id === 'pages').recipeHash = h(83);
  const after = keyMap(leaf); assert.equal(after.base, before.base); assert.equal(after.catalog, before.catalog); assert.notEqual(after.pages, before.pages);
});

test('keys include dependency identities and exclude cache state, targets, labels and unused sources', () => {
  const input = example(), before = keyMap(input);
  input.title = 'A different build title'; input.targets[0].label = 'A different target label'; input.cache = [{ taskId: 'base', key: h(90), artifactPresent: false }]; input.sources.push({ id: 'unused', sha256: h(91) });
  assert.deepEqual(keyMap(input), before);
  input.tasks.find(task => task.id === 'pages').dependencies = [];
  assert.notEqual(keyMap(input).pages, before.pages);
  const renamed = example(); renamed.tasks[0].id = 'renamed'; for (const task of renamed.tasks) task.dependencies = task.dependencies.map(id => id === 'base' ? 'renamed' : id);
  assert.notEqual(keyMap(renamed).catalog, before.catalog);
});

test('set ordering is canonical and plans remain deterministic across reordered exports', () => {
  const input = example(), reordered = example();
  for (const key of ['sources', 'tasks', 'targets', 'cache']) reordered[key].reverse();
  for (const task of reordered.tasks) { task.sourceIds.reverse(); task.dependencies.reverse(); }
  assert.deepEqual(validateInput(reordered), validateInput(input)); assert.deepEqual(fingerprints(reordered), fingerprints(input));
  assert.deepEqual(analyzeRebuild(reordered, choices(reordered)), analyzeRebuild(input, choices(input)));
});

test('all Skip is a complete empty plan while Unknown and missing answers block all analysis', () => {
  const input = example(), targets = validateInput(input).targets;
  const rows = values => targets.map((target, i) => ({ targetId: target.id, choice: values[i] }));
  const result = rebuildPlan(input, rows(['skip', 'skip'])); assert.equal(result.status, 'complete'); assert.deepEqual(result.analysis.steps, []); assert.equal(result.analysis.nothingRequested, true); assert.equal(result.analysis.noRebuildRequired, true);
  assert.equal(rebuildPlan(input, rows(['require', 'unknown'])).status, 'unknown'); assert.equal(rebuildPlan(input, rows(['require', 'unknown'])).analysis, null);
  assert.equal(rebuildPlan(input, rows([null, 'unknown'])).status, 'incomplete');
  for (const bad of [{}, { catalog: 'require' }, { ...choices(input), extra: 'skip' }, choices(input, 'unknown')]) assert.throws(() => analyzeRebuild(input, bad));
  assert.throws(() => rebuildPlan(input, rows(['require', 'skip']).reverse()));
});

test('invalid DAGs, references, duplicates, hashes and unsupported fields fail before planning', () => {
  const mutations = [
    x => { x.tasks[0].dependencies = ['base']; }, x => { x.tasks[0].dependencies = ['pages']; }, x => { x.tasks[0].dependencies = ['absent']; },
    x => { x.tasks[0].sourceIds = ['absent']; }, x => { x.tasks[0].sourceIds = ['data', 'data']; }, x => { x.tasks[1].dependencies = ['base', 'base']; },
    x => { x.tasks[1].id = x.tasks[0].id; }, x => { x.sources[1].id = x.sources[0].id; }, x => { x.targets[1].taskId = x.targets[0].taskId; },
    x => { x.targets[1].id = x.targets[0].id; }, x => { x.targets[0].taskId = 'absent'; }, x => { x.sources[0].sha256 = 'A'.repeat(64); },
    x => { x.tasks[0].recipeHash += '\n'; }, x => { x.tasks[0].environmentHash = 'abc'; }, x => { x.cache = [{ taskId: 'base', key: h(1), artifactPresent: 1 }]; },
    x => { x.cache = [{ taskId: 'absent', key: h(1), artifactPresent: true }]; }, x => { x.cache = Array(2).fill({ taskId: 'base', key: h(1), artifactPresent: true }); },
    x => { x.tasks[0].command = 'touch file'; }, x => { x.tasks[0].id = 'constructor'; }, x => { x.title += '\n'; }, x => { x.targets[0].label = '\ud800'; },
    x => { delete x.tasks[0]; }, x => { x.sources[0] = null; }, x => { x.targets = []; }, x => { x.tasks = []; }, x => { x.cache[0] = undefined; },
  ];
  for (const mutate of mutations) { const input = example(); mutate(input); assert.throws(() => validateInput(input)); }
});

test('source-free task is valid and Questions disclose target identity without source/cache digests', () => {
  const input = example(); input.sources = []; input.tasks.forEach(task => { task.sourceIds = []; });
  assert.equal(fingerprints(input).tasks.length, 3);
  const request = requestFor(example(), CONFIG, 'catalog', id(1));
  assert.match(request.prompt, /Card asset build \(card-assets\)/); assert.match(request.prompt, /Target catalog, task catalog/); assert.ok(request.prompt.length <= 500);
  assert.equal(request.data.policy_hash, POLICY_HASH); assert.equal(request.target_user_id, CONFIG.participant.id);
  assert.ok(!JSON.stringify(request).includes(fixture.sources[0].sha256)); assert.ok(!JSON.stringify(request).includes(fixture.tasks[0].recipeHash));
});

test('maximum snapshot fits eight Questions and a private complete export', async t => {
  const input = { buildId: 'maximum', title: 'Maximum fixture', sources: Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, sha256: h(i) })), tasks: [], cache: [], targets: [] };
  input.tasks = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, recipeHash: h(100 + i), environmentHash: h(200), sourceIds: input.sources.map(source => source.id), dependencies: Array.from({ length: i }, (_, j) => `t${j}`) }));
  input.targets = Array.from({ length: 8 }, (_, i) => ({ id: `target${i}`, label: `Output ${i}`, taskId: `t${i + 4}` }));
  const directory = await mkdtemp(join(tmpdir(), 'rebuild-maximum-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const now = () => '2026-01-01T09:00:00.000Z', api = mockApi(now), options = { client: api.client, directory, input, config: CONFIG, token: 'fixture', room: ROOM_CODE, now };
  for (let i = 0; i < 8; i++) { const pending = await step(options); api.answer(pending.answers.find(row => row.status === 'pending').questionId, 'require'); await step(options); }
  const result = await exportAnalysis(directory, input); assert.equal(result.analysis.rebuildTaskIds.length, 12);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1024 * 1024); assert.equal((await stat(join(directory, 'analysis.json'))).mode & 0o777, 0o600);
  assert.equal(api.calls.filter(call => call.method === 'POST').length, 8);
});
