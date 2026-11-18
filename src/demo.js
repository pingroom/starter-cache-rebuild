import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson } from './storage.js';
import { step, exportAnalysis } from './engine.js';
import { fingerprints } from './model.js';
import { mockApi, CONFIG, ROOM_CODE } from './mock.js';

const fixture = await readJson(new URL('../examples/build.json', import.meta.url), 65536);
for (const [scenario, choices] of [
  ['cold-build', ['require', 'require']],
  ['cached-target-prunes-missing-ancestor', ['skip', 'require']],
  ['nothing-requested', ['skip', 'skip']],
  ['unknown', ['require', 'unknown']],
]) {
  const input = structuredClone(fixture);
  if (scenario === 'cached-target-prunes-missing-ancestor') input.cache = fingerprints(input).tasks.filter(row => row.taskId === 'pages').map(row => ({ taskId: row.taskId, key: row.key, artifactPresent: true }));
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-rebuild-demo-'));
  try {
    const now = () => '2026-01-01T09:00:00.000Z', api = mockApi(now);
    const options = { client: api.client, directory, input, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now };
    let result;
    for (const choice of choices) {
      const pending = await step(options), question = pending.answers.find(answer => answer.status === 'pending');
      api.answer(question.questionId, choice); result = await step(options);
    }
    assert.equal(api.calls.filter(call => call.method === 'POST').length, 2);
    if (scenario === 'unknown') {
      assert.equal(result.status, 'unknown'); assert.equal(result.analysis, null); await assert.rejects(exportAnalysis(directory, input));
    } else {
      assert.equal(result.status, 'complete');
      if (scenario === 'cold-build') assert.deepEqual(result.analysis.rebuildTaskIds, ['base', 'catalog', 'pages']);
      if (scenario === 'cached-target-prunes-missing-ancestor') { assert.deepEqual(result.analysis.rebuildTaskIds, []); assert.deepEqual(result.analysis.reusedTaskIds, ['pages']); }
      if (scenario === 'nothing-requested') assert.deepEqual(result.analysis.steps, []);
      await exportAnalysis(directory, input);
    }
    console.log(JSON.stringify({ scenario, transport: 'local mock through the real SDK; no live delivery', status: result.status, analysis: result.analysis, unknownTargetIds: result.unknownTargetIds }, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
