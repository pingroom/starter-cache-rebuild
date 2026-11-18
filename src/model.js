import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const TOKEN = /^[^\s\x00-\x1f\x7f]{1,8192}(?![\s\S])/;
export const ROOM = /^[A-Z0-9]{12}$(?![\s\S])/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$(?![\s\S])/.test(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed()
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$(?![\s\S])/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}


const safeId = value => word(value) && value.length <= 12 && !['constructor', 'prototype', '__proto__'].includes(value);
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$(?![\s\S])/.test(value);
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export const KEY_FORMAT = 'pingroom-task-key-v1';
export const POLICY = Object.freeze({ name: 'declared-cache-rebuild-v1', keyFormat: KEY_FORMAT,
  keyEncoding: 'SHA256 of UTF-8 canonical JSON; object keys and source/dependency IDs in ASCII order',
  keyInputs: 'task ID, recipe hash, environment hash, direct source IDs/hashes and dependency IDs/keys',
  traversal: 'required targets by ID; dependencies by ID; postorder; shared tasks once',
  cacheHit: 'matching expected key and declared artifactPresent true; prune dependency execution',
  unknown: 'withhold whole plan', execution: 'local plan only; no artifact checks, builds or cache writes' });
export const POLICY_HASH = hash(POLICY);
const promptFor = (input, target) => `${input.title} (${input.buildId})\nTarget ${target.id}, task ${target.taskId}: ${target.label}\nIs this output required for this build? Require requests it; Skip leaves it unrequested unless another required output needs the same task. Unknown withholds the whole rebuild plan. This records output intent only; no build or cache write runs.`;
function references(values, known, label) {
  if (!Array.isArray(values) || values.length > known.size || new Set(values).size !== values.length || Array.from(values).some(id => !known.has(id))) throw new Error(`${label} must be distinct declared IDs.`);
  return [...values].sort(order);
}
export function validateInput(input) {
  if (!keys(input, ['buildId', 'title', 'sources', 'tasks', 'cache', 'targets']) || !word(input.buildId) || !line(input.title, 40)
    || !Array.isArray(input.sources) || input.sources.length > 12 || !Array.isArray(input.tasks) || input.tasks.length < 1 || input.tasks.length > 12
    || !Array.isArray(input.cache) || input.cache.length > 12 || !Array.isArray(input.targets) || input.targets.length < 1 || input.targets.length > 8) throw new Error('Supply build metadata, up to 12 sources, 1–12 tasks, up to 12 cache records and 1–8 output targets.');
  const sourceIds = new Set(), taskIds = new Set();
  const sources = Array.from(input.sources, source => {
    if (!keys(source, ['id', 'sha256']) || !safeId(source.id) || sourceIds.has(source.id) || !digest(source.sha256)) throw new Error('Sources need distinct safe IDs and lowercase SHA256 hex strings.');
    sourceIds.add(source.id); return { ...source };
  }).sort((a, b) => order(a.id, b.id));
  for (const task of Array.from(input.tasks)) {
    if (!keys(task, ['id', 'recipeHash', 'environmentHash', 'sourceIds', 'dependencies']) || !safeId(task.id) || taskIds.has(task.id)
      || !digest(task.recipeHash) || !digest(task.environmentHash)) throw new Error('Tasks need distinct safe IDs, exact fields and lowercase recipe/environment SHA256 hashes.');
    taskIds.add(task.id);
  }
  const tasks = input.tasks.map(task => ({ id: task.id, recipeHash: task.recipeHash, environmentHash: task.environmentHash,
    sourceIds: references(task.sourceIds, sourceIds, 'Source references'), dependencies: references(task.dependencies, taskIds, 'Task dependencies') })).sort((a, b) => order(a.id, b.id));
  const byId = new Map(tasks.map(task => [task.id, task])), seen = new Set(), active = new Set();
  function visit(id) {
    if (active.has(id)) throw new Error('Task dependencies must form a DAG; a cycle was found.');
    if (seen.has(id)) return;
    active.add(id); for (const dependency of byId.get(id).dependencies) visit(dependency); active.delete(id); seen.add(id);
  }
  for (const task of tasks) visit(task.id);
  const cached = new Set();
  const cache = Array.from(input.cache, entry => {
    if (!keys(entry, ['taskId', 'key', 'artifactPresent']) || !taskIds.has(entry.taskId) || cached.has(entry.taskId) || !digest(entry.key)
      || typeof entry.artifactPresent !== 'boolean') throw new Error('Cache records need a distinct declared taskId, lowercase SHA256 key and Boolean artifactPresent.');
    cached.add(entry.taskId); return { ...entry };
  }).sort((a, b) => order(a.taskId, b.taskId));
  const targetIds = new Set(), targetTasks = new Set();
  const targets = Array.from(input.targets, target => {
    if (!keys(target, ['id', 'label', 'taskId']) || !safeId(target.id) || targetIds.has(target.id) || !line(target.label, 60)
      || !taskIds.has(target.taskId) || targetTasks.has(target.taskId)) throw new Error('Targets need distinct safe IDs, labels and distinct declared task IDs.');
    targetIds.add(target.id); targetTasks.add(target.taskId); return { ...target };
  }).sort((a, b) => order(a.id, b.id));
  if (targets.some(target => promptFor(input, target).length > 500)) throw new Error('Target prompt exceeds 500 UTF-16 units.');
  return { buildId: input.buildId, title: input.title, sources, tasks, cache, targets };
}
export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id) || !line(config.participant.label, 60)) throw new Error('Config requires an exact build owner UUID and label.');
  return structuredClone(config);
}
export const itemsFor = input => validateInput(input).targets;
export function requestFor(rawInput, config, itemId, attemptId) {
  const input = validateInput(rawInput); validateConfig(config); const target = input.targets.find(target => target.id === itemId);
  if (!target || !isId(attemptId)) throw new Error('Invalid output target or attempt.');
  const key = `rebuild-${attemptId}`;
  return { prompt: promptFor(input, target), context: `To ${config.participant.id}`,
    options: [{ value: 'require', label: 'Require', style: 'default' }, { value: 'skip', label: 'Skip', style: 'default' }, { value: 'unknown', label: 'Unknown', style: 'default' }],
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), target_hash: hash(target), policy_hash: POLICY_HASH, item_id: target.id, attempt_id: attemptId }, idempotencyKey: key };
}

/** Expected task keys only; neither reads artifacts nor changes cache records. */
export function fingerprints(rawInput) {
  const input = validateInput(rawInput), remaining = new Set(input.tasks.map(task => task.id)), computed = new Map();
  const sources = new Map(input.sources.map(source => [source.id, source.sha256])), tasks = [];
  while (remaining.size) {
    const task = input.tasks.find(task => remaining.has(task.id) && task.dependencies.every(id => computed.has(id)));
    if (!task) throw new Error('Internal topological ordering failure.');
    const preimage = { format: KEY_FORMAT, taskId: task.id, recipeHash: task.recipeHash, environmentHash: task.environmentHash,
      sources: task.sourceIds.map(id => ({ id, sha256: sources.get(id) })), dependencies: task.dependencies.map(id => ({ id, key: computed.get(id) })) };
    const key = hash(preimage); computed.set(task.id, key); remaining.delete(task.id); tasks.push({ taskId: task.id, key, preimage });
  }
  return { keyFormat: KEY_FORMAT, inputHash: hash(input), tasks };
}

/** A deterministic proposal using declared cache metadata; CLI export adds owner evidence. */
export function analyzeRebuild(rawInput, selections) {
  const input = validateInput(rawInput), ids = input.targets.map(target => target.id);
  if (!keys(selections, ids) || ids.some(id => !['require', 'skip'].includes(selections[id]))) throw new Error('Every target needs exactly one known Require or Skip selection.');
  const expected = fingerprints(input), cache = new Map(input.cache.map(entry => [entry.taskId, entry])), tasks = new Map(input.tasks.map(task => [task.id, task]));
  const records = new Map(expected.tasks.map(({ taskId, key }) => {
    const previous = cache.get(taskId), cacheStatus = !previous ? 'absent_record' : previous.key !== key ? 'key_mismatch' : !previous.artifactPresent ? 'artifact_missing' : 'hit';
    return [taskId, { taskId, expectedKey: key, previousKey: previous?.key ?? null, declaredArtifactPresent: previous?.artifactPresent ?? null, cacheStatus, execution: 'not_requested' }];
  }));
  const steps = [], seen = new Set(), sourceIds = new Set();
  function visit(taskId) {
    if (seen.has(taskId)) return;
    seen.add(taskId); const row = records.get(taskId);
    if (row.cacheStatus === 'hit') { row.execution = 'reuse'; steps.push({ taskId, action: 'reuse', expectedKey: row.expectedKey }); return; }
    const task = tasks.get(taskId);
    for (const dependency of task.dependencies) visit(dependency);
    for (const sourceId of task.sourceIds) sourceIds.add(sourceId);
    row.execution = 'rebuild'; steps.push({ taskId, action: 'rebuild', reason: row.cacheStatus, expectedKey: row.expectedKey, previousKey: row.previousKey });
  }
  const targets = input.targets.map(target => ({ ...target, selection: selections[target.id] }));
  for (const target of targets) if (target.selection === 'require') visit(target.taskId);
  const rebuildTaskIds = steps.filter(step => step.action === 'rebuild').map(step => step.taskId), reusedTaskIds = steps.filter(step => step.action === 'reuse').map(step => step.taskId);
  return { targets, taskKeys: expected, tasks: [...records.values()].sort((a, b) => order(a.taskId, b.taskId)), steps, rebuildTaskIds, reusedTaskIds,
    neededSourceIds: [...sourceIds].sort(order), nothingRequested: steps.length === 0, noRebuildRequired: rebuildTaskIds.length === 0, buildExecuted: false, cacheWritten: false, artifactsVerified: false,
    sourceHash: hash(input), policyHash: POLICY_HASH };
}
export function rebuildPlan(rawInput, answers) {
  const input = validateInput(rawInput);
  if (!Array.isArray(answers) || answers.length !== input.targets.length || Array.from(answers).some((row, index) => !keys(row, ['targetId', 'choice']) || row.targetId !== input.targets[index].id || ![null, 'require', 'skip', 'unknown'].includes(row.choice))) throw new Error('Supply one ordered Require, Skip, Unknown or null choice per target.');
  const missingTargetIds = answers.filter(row => row.choice === null).map(row => row.targetId), unknownTargetIds = answers.filter(row => row.choice === 'unknown').map(row => row.targetId);
  const status = missingTargetIds.length ? 'incomplete' : unknownTargetIds.length ? 'unknown' : 'complete';
  return { status, missingTargetIds, unknownTargetIds, analysis: status === 'complete' ? analyzeRebuild(input, Object.fromEntries(answers.map(row => [row.targetId, row.choice]))) : null };
}

export function validateState(state, rawInput) {
  const input = validateInput(rawInput);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || !/^[0-9a-f]{64}$(?![\s\S])/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > itemsFor(input).length || iso(state.startedAt) !== state.startedAt) throw new Error('Invalid state or changed build snapshot. Restore the original input and configuration.');
  validateConfig(state.config);
  const items = itemsFor(input), ids = new Set(), questionIds = new Set(); let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'itemId', 'createdAt', 'request', 'questionId', 'status', 'observation']) || !isId(attempt.id) || ids.has(attempt.id)
      || attempt.itemId !== items[index].id || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.itemId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved target selection or order.');
    ids.add(attempt.id); previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId); validateObservation(attempt.observation, attempt.status, attempt.request);
      if (attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates its saved creation intent.');
      previous = attempt.observation.checkedAt;
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS) throw new Error('Question predates its saved creation intent.');
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) throw new Error('Only the last confirmation may have an active Question.');
  }
  return state;
}



export function report(state, rawInput) {
  const input = validateInput(rawInput); validateState(state, input);
  const answers = input.targets.map(target => {
    const attempt = state.attempts.find(row => row.itemId === target.id), answer = attempt?.observation?.answer;
    return { targetId: target.id, status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
      choice: answer?.value ?? null, label: answer?.label ?? null, questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null,
      responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null, askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null };
  });
  const calculation = rebuildPlan(input, answers.map(({ targetId, choice }) => ({ targetId, choice })));
  const active = answers.find(row => ['create_unknown', 'pending'].includes(row.status));
  const status = active?.status ?? (answers.some(row => row.status === 'unasked') ? 'ready' : calculation.status);
  return { version: 1, buildId: input.buildId, sourceHash: hash(input), source: input, policy: POLICY, policyHash: POLICY_HASH,
    participant: state.config.participant, room: state.room, configHash: hash(state.config), answers, ...calculation, status };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some((option) => option.value === answer.value && option.label === answer.label)
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved target selection evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered target selections must not contain target selection evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || (q.is_handoff !== undefined && q.is_handoff !== false)
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || (q.results !== undefined && q.results !== null) || q.text_input !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== request.options.length
    || Array.from(q.options).some((option, index) => option?.value !== request.options[index].value || option?.label !== request.options[index].label
      || (option?.primary !== undefined && option.primary !== false) || (option?.destructive !== undefined && option.destructive !== false))) throw new Error('Question does not match the saved configuration, room, or reviewer.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.text !== null || answer.responder?.id !== request.target_user_id
        || !request.options.some((option) => option.value === answer.value && option.label === answer.label)) throw new Error('Invalid answer.');
      observation.answer = { value: answer.value, label: answer.label, responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
