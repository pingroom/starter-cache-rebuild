# Cache rebuild planning with PingRoom

Let a build owner choose required outputs through PingRoom, then calculate which tasks can reuse cached artifacts and which need rebuilding. Code derives task keys from a fixed dependency graph and current source, recipe and environment hashes.

This starter exports a local plan. It does not read source files, inspect artifacts, run commands, upload artifacts or write a cache. The card-assets example uses synthetic hashes; replace them with metadata from your build adapter.

## Try it offline

Choose **Use this template**, clone your copy and install Node.js 22 or newer:

```sh
npm ci
npm test
npm run demo
cp examples/build.json build.json
cp config.example.json config.json
npm run preview
npm run fingerprint
```

The four demos cover a cold build, a cached target with missing ancestors, no requested outputs, and Unknown blocking export. Tests and demos use the pinned SDK through a local mock transport, require no credentials and remove temporary files. Live phone delivery is not tested.

## Define a build snapshot

Edit `build.json` before starting. `preview` prints the validated snapshot without contacting PingRoom.

| Field | Meaning |
| --- | --- |
| `buildId`, `title` | Stable build identifier and a short title. |
| `sources` | 0–12 `{id,sha256}` records for current source content. |
| `tasks` | 1–12 `{id,recipeHash,environmentHash,sourceIds,dependencies}` records. A dependency ID names a task whose output this task consumes. |
| `cache` | 0–12 `{taskId,key,artifactPresent}` records from a prior cache snapshot. |
| `targets` | 1–8 `{id,label,taskId}` candidate outputs for the owner to select. Each target names a distinct task. |

Entry IDs start with a lowercase letter, use lowercase letters, digits, `_` or `-`, and contain at most 12 characters. Entry IDs cannot be reserved prototype names. `buildId` uses the same alphabet with a 40-character limit. Titles allow 40 UTF-16 units and target labels 60; text must be trimmed, well formed and free of control/format characters. Question prompts cannot exceed 500 UTF-16 units. Extra fields are rejected.

Hashes are exactly 64 lowercase hexadecimal characters. Every source, task and target ID must be unique within its list. References must exist, reference arrays cannot contain duplicates, cache records cannot repeat a task, and task dependencies must form a DAG. Self-dependencies and cycles fail validation. All set-like arrays are sorted by ID, so reordering an export preserves its identity. Content changes do not.

Your adapter must include every material input in the supplied hashes. `recipeHash` should cover the task implementation and build options. `environmentHash` should cover relevant toolchain and environment inputs. Undeclared inputs, nondeterministic recipes or inaccurate metadata can make a matching key unsafe to reuse. The template cannot discover these omissions or verify that an artifact exists or is intact. `artifactPresent` is only your adapter's Boolean declaration.

## Generate and compare keys

`npm run fingerprint` prints each task's expected key and exact preimage offline, in dependency order. Use these values to integrate an existing cache. `fingerprints(input)` from `src/model.js` provides the same data to a local adapter.

The key format is `pingroom-task-key-v1`. Each task preimage contains:

- `format`, `taskId`, `recipeHash` and `environmentHash`;
- direct `sources`, sorted by ID, with each source's `id` and `sha256`;
- direct `dependencies`, sorted by ID, with each dependency's `id` and computed `key`.

Code hashes UTF-8 JSON with object keys sorted in ASCII order and no whitespace. Source changes propagate through dependency keys. Labels, requested targets and prior cache metadata do not affect task keys. Changing the key format requires a new version and invalidates old keys.

After an external builder produces and verifies an artifact, its adapter may store the expected key with `artifactPresent: true`. The fingerprint command establishes neither successful execution nor artifact presence. Freeze the snapshot before collecting output selections; changing cache metadata requires a new session even when task keys stay unchanged.

## Connect the build owner

Install [PingRoom](https://pingroom.io/i), then run:

```sh
npm run connect
npm run inspect
```

Approve the pairing link and grant the intended standard private room. The connection needs room-list access and permission to create and read Questions. Verify the owner in the app, then set their exact member UUID and a label in `config.json`. Names alone do not establish identity.

For an existing connection, copy `.env.example` to `.env` and set both `PINGROOM_TOKEN` and `PINGROOM_ROOM`. Partial or blank pairs fail rather than mixing connection sources.

```sh
npm start
```

Each invocation creates at most one direct Question or reads the pending one. After the owner answers, run again to save it, then again for the next target. Questions follow target-ID order and last 15 minutes.

- **Require:** include this output in the plan.
- **Skip:** do not request this output directly. Its task may still be needed by another required output.
- **Unknown:** withhold the whole plan.

Questions send the build title/ID, target ID/label, task ID, owner UUID and input/target/policy hashes. Source hashes, recipes, environment hashes, dependency lists and cache records remain in local files. The application checks the exact request, room, owner, asking registration and timestamps before using a response. It never polls or resends automatically.

## Read the rebuild plan

```sh
npm run status
npm run report
npm run export
```

These commands run locally without credentials. `report` writes `.rebuild/report.json`, including partial evidence. `export` writes `.rebuild/analysis.json` only after every target has a known attributed answer. Read the exported report's `analysis` field for the plan and `answers` for the owner evidence.

A cache hit requires both a matching expected key and `artifactPresent: true`. **A hit stops execution traversal at that task.** Its missing or stale ancestors do not need rebuilding unless another required output needs them. All keys are still recomputed offline to determine whether the hit is valid.

For a cache miss, code visits dependencies before adding the task's rebuild step. Targets and dependencies use ID order; shared tasks appear once. Each rebuild records one reason:

| Reason | Meaning |
| --- | --- |
| `absent_record` | No cache record exists for this task. |
| `key_mismatch` | The previous key differs from the expected key, regardless of the presence flag. |
| `artifact_missing` | The key matches but the artifact is declared absent. |

These reasons include expected and previous keys where available. They cannot identify a changed source or recipe because prior component preimages are not supplied.

`analysis.steps` contains ordered `reuse` and `rebuild` entries. `tasks` includes every task's key comparison and execution status: `reuse`, `rebuild` or `not_requested`. `rebuildTaskIds`, `reusedTaskIds` and `neededSourceIds` summarize the plan. `nothingRequested` means there are no steps; `noRebuildRequired` also covers plans consisting only of cache hits. All Skip is a valid empty plan. Unknown, missing, expired, cancelled or invalid answers withhold all analysis.

Adapt the input exporter and consume this report in a separate build adapter. Recheck artifact validity and source freshness before executing a plan. Build execution, cache retrieval, publication and deployment are unimplemented.

## Resume safely

Keep `build.json`, `config.json`, `.rebuild/` and the original connection together. Changed inputs, identities or credentials cannot reuse the session. Resolve outstanding work before archiving it for a new snapshot.

After a lost create response, preserve `.rebuild/state.json`. Run `npm run find-id`, inspect candidates, then `npm run recover -- QUESTION_UUID` for the original Question. An empty bounded search does not prove creation failed. Never delete state to retry a send.

Pairing preserves pending credentials/session or uncertain creation intent. Resume a known pairing with `npm run connect`; inspect Connected Agents and resolve or revoke an uncertain or expired registration before starting another connection. Remove stale locks only after confirming no process remains active.

Inputs, credentials and generated evidence are ignored by Git. Files use private atomic writes (`0600`, directories `0700`) under a local lock. Input/config limits are 64/16 KiB; output files are bounded to 1 MiB. Hashes detect mismatches; they are not signed history or artifact attestations.

Run/recover exits `0` for a complete plan, `1` for errors, `2` for incomplete or failed answers, `3` for pending/ready/interrupted work and `4` for uncertain creation. Successful local inspection/reporting exits `0`, including partial evidence. Refused exports exit `1`.

The starter pins `@pingroom/sdk` 0.8.0 with a lockfile. `.npmrc` requests exact saves and a 14-day minimum release age where npm supports it. Commit-pinned Actions check Node 22 and 24. Tests include 4,096 graph/cache/target comparisons against an independent closure oracle, recursive key verification, recovery, pairing and actual CLI subprocesses. MIT licensed.
