import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createEmptyWoohaa3ServerCanvas, normalizeGlbModelReference, type WorldResourceEdit, type CanvasNodeData } from '@woohaa3/contracts';
import { CanvasRoom } from '../sync/room.js';
import { SqliteYjsRepository } from '../storage/sqlite/yjs.js';
import { loadNodeSqlite } from '../storage/sqlite/sqlite-loader.js';
import { createWorldAuthoringAuthority } from './authority.js';
import { createWorldAuthoringService } from './scene-area-service.js';
import { createAssistantWorldService } from './assistant-service.js';
import { createWorldCameraSettingsService } from './camera-service.js';
import { InMemoryWorldCameraHistoryRepository } from './camera-history.js';
import { SqliteAssistantHostCompletionRepository } from '../storage/sqlite/host-completions.js';
import { executeSceneIr } from '../model-mcp/script-executor.js';

const closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0).reverse()) close(); });
const BOX = "scene.box({ id: 'base', size: [1, 1, 1], color: '#888888' });";
async function fixture(allowSceneAreaExpansion = false, setup?: (canvas: ReturnType<typeof createEmptyWoohaa3ServerCanvas>) => void, failWrites?: () => boolean, executeScene: typeof executeSceneIr = executeSceneIr) {
  const directory = mkdtempSync(join(tmpdir(), 'world-resources-'));
  closers.push(() => rmSync(directory, { force: true, recursive: true }));
  const canvas = createEmptyWoohaa3ServerCanvas('canvas');
  canvas.document.nodes.push({ id: 'area', type: 'scene-area', position: { x: 0, y: 0 } });
  canvas.nodeData.area = { title: '导演区', sceneArea: { kind: 'scene-area', version: 'shared-world-v1', areaId: 'area-1', scopeVersion: 'scope-1', bounds: { min: { u: -10, v: -10 }, max: { u: 10, v: 10 } } } } as CanvasNodeData;
  setup?.(canvas);
  const authority = createWorldAuthoringAuthority({ executeScene, verifyStopped: () => true });
  const repositoryPath = join(directory, 'canvas.sqlite');
  const repository = new SqliteYjsRepository({ path: repositoryPath, spatialAuthority: authority, ...(failWrites ? { failWrites } : {}) });
  const closeRepository = () => repository.close();
  closers.push(closeRepository);
  const room = new CanvasRoom({ canvasId: canvas.id, repository });
  await room.initialize({ canvas, roomEpoch: 'epoch', createdAt: new Date().toISOString() });
  const closeRoom = () => room.dispose();
  closers.push(closeRoom);
  const worldAuthoring = createWorldAuthoringService({ authority, resolveRoom: async () => room,
    acquire: async intent => repository.acquireSpatialRun(intent), cancel: async (id, request) => repository.cancelSpatialRun(id, request),
    findLatest: async (id, operationId) => repository.findLatestWorldAuthoringCommand(id, operationId) });
  const history = new InMemoryWorldCameraHistoryRepository();
  let assistant: ReturnType<typeof createAssistantWorldService>;
  const cameraSettings = createWorldCameraSettingsService({ resolveRoom: async () => room, resolveContext: (id, context) => worldAuthoring.resolveCapability(id, context), history,
    verifyCompletion: (completion, evidence) => assistant.verifyCompletion(completion, evidence) });
  const completionPath = join(directory, "completions.sqlite");
  let hostCompletions = new SqliteAssistantHostCompletionRepository({ path: completionPath });
  const closeCompletions = () => hostCompletions.close();
  closers.push(closeCompletions);
  const makeAssistant = () => createAssistantWorldService({ hostCompletions, authority, worldAuthoring, cameraSettings, resolveRoom: async () => room,
    cancel: async (id, request) => repository.cancelSpatialRun(id, request),
    confirmStopped: async input => repository.confirmSpatialStopped(input.canvasId, input.requestId, input.runId, input.epoch, input.executionId, input.evidence), pending: async () => repository.pendingSpatialRuns() });
  assistant = makeAssistant();
  const closeAssistant = () => assistant.close();
  closers.push(closeAssistant);
  const issued = await assistant.issue({ canvasId: canvas.id, requestId: 'run', runId: 'run', epoch: 0, executionId: 'exec', scope: { kind: 'scene-area', areaId: 'area-1' }, allowSceneAreaExpansion });
  if (!issued.ok) throw Error(issued.message);
  let contextId = issued.context.contextId;
  const edit = (input: WorldResourceEdit) => assistant.write({ contextId, operation: { kind: 'edit-resource', operationId: input.operationId, edit: input } });
  const read = async () => { const result = await assistant.read({ canvasId: canvas.id, contextId }); if (!result.ok) throw Error(result.message); return result.view; };
  const create = async (operationId = 'create-model', initialScript?: string) => {
    const result = await edit({ resourceType: 'world_model', operation: 'create', operationId, areaId: 'area-1', title: '箱子', initialScript,
      transform: { version: 'shared-world-v1', position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 } });
    if (!result.ok || !result.target || !('instanceId' in result.target)) throw Error(JSON.stringify(result));
    return { result, instanceId: result.target.instanceId };
  };
  const restart = async (reissue = true) => {
    assistant.close();
    hostCompletions.close();
    hostCompletions = new SqliteAssistantHostCompletionRepository({ path: completionPath });
    assistant = makeAssistant();
    if (!reissue) return assistant;
    const next = await assistant.issue({ canvasId: canvas.id, requestId: 'run', runId: 'run', epoch: 0, executionId: 'exec', scope: { kind: 'scene-area', areaId: 'area-1' }, allowSceneAreaExpansion });
    if (!next.ok) throw Error(next.message);
    contextId = next.context.contextId;
    return assistant;
  };
  const restartForReceipt = () => {
    assistant.close();
    const reopened = new SqliteYjsRepository({ path: repositoryPath, spatialAuthority: authority });
    closers.push(() => reopened.close());
    assistant = createAssistantWorldService({ hostCompletions, authority, worldAuthoring, cameraSettings, resolveRoom: async () => room,
      cancel: async (id, request) => reopened.cancelSpatialRun(id, request),
      confirmStopped: async input => reopened.confirmSpatialStopped(input.canvasId, input.requestId, input.runId, input.epoch, input.executionId, input.evidence), pending: async () => reopened.pendingSpatialRuns() });
    return assistant;
  };
  const stop = () => {
    for (const close of [closeAssistant, closeCompletions, closeRoom, closeRepository]) {
      const index = closers.indexOf(close);
      if (index >= 0) { closers.splice(index, 1); close(); }
    }
    worldAuthoring.close();
  };
  return { room, assistant, worldAuthoring, repository, repositoryPath, contextId, edit, read, create, history, get hostCompletions() { return hostCompletions; }, restart, restartForReceipt, stop };
}

it('creates a skeleton, creates/appends/patches its source, rejects stale and reused operations, and deletes safely', async () => {
  const f = await fixture();
  const { result: created, instanceId } = await f.create();
  expect((await f.read()).sceneModels).toEqual(expect.arrayContaining([expect.objectContaining({ instanceId })]));
  const target = { instanceId };
  const source = await f.edit({ resourceType: 'world_model_script', operation: 'create', operationId: 'source-create', target, expectedParentVersion: created.version, script: BOX });
  expect(source, JSON.stringify(source)).toMatchObject({ ok: true });
  if (!source.ok) throw Error(JSON.stringify(source));
  const patch = { resourceType: 'world_model_script' as const, operation: 'patch' as const, operationId: 'source-patch', target, expectedVersion: source.version, edits: [{ oldString: "'#888888'", newString: "'#336699'" }] };
  const patched = await f.edit(patch);
  expect(patched).toMatchObject({ ok: true });
  expect(await f.edit(patch)).toEqual({ ...patched, duplicate: true });
  expect(await f.edit({ ...patch, edits: [{ oldString: 'x', newString: 'y' }] })).toMatchObject({ ok: false, code: 'operation-conflict' });
  expect(await f.edit({ ...patch, operationId: 'stale' })).toMatchObject({ ok: false, code: 'version-conflict' });
  if (!patched.ok) throw Error(JSON.stringify(patched));
  const invalid = await f.edit({ ...patch, operationId: 'atomic', expectedVersion: patched.version, edits: [{ oldString: "'#336699'", newString: "'#ffffff'" }, { oldString: 'missing', newString: 'x' }] });
  expect(invalid).toMatchObject({ ok: false, code: 'patch-not-found', editIndex: 1 });
  expect((await f.read()).modelScripts?.[instanceId]).toContain('#336699');
  const appended = await f.edit({ resourceType: 'world_model_script', operation: 'append', operationId: 'append', target, expectedVersion: patched.version, chunk: "\nscene.box({ id: 'top', size: [1, 0.2, 1], position: [0, 1, 0] });" });
  expect(appended).toMatchObject({ ok: true });
  if (!appended.ok) throw Error(JSON.stringify(appended));
  const replaced = await f.edit({ resourceType: 'world_model_script', operation: 'replace', operationId: 'source-replace', target, expectedVersion: appended.version, script: BOX });
  expect(replaced).toMatchObject({ ok: true });
  if (!replaced.ok) throw Error(JSON.stringify(replaced));
  const removed = await f.edit({ resourceType: 'world_model_script', operation: 'delete', operationId: 'source-delete', target, expectedVersion: replaced.version });
  expect(removed).toMatchObject({ ok: true, deleted: true });
  expect((await f.read()).modelScripts?.[instanceId]).toBe('');
  const view = await f.read();
  const deletion = { resourceType: 'world_model' as const, operation: 'delete' as const, operationId: 'model-delete', target, expectedVersion: view.resourceVersions?.[`world_model:${instanceId}`] };
  const gone = await f.edit(deletion);
  expect(gone).toMatchObject({ ok: true, deleted: true });
  expect(await f.edit(deletion)).toEqual({ ...gone, duplicate: true });
  const persisted = await f.repository.getCommandRecord('canvas', gone.ok ? gone.commandId : '');
  expect(persisted?.resourceEdit).toMatchObject({ target, deleted: true });
  expect(await f.assistant.settleRun({ canvasId: 'canvas', runId: 'run', status: 'succeeded', evidence: {} })).toMatchObject({ ok: true });
  const snapshot = await f.repository.captureArchiveState('canvas');
  await f.repository.replaceArchiveState('canvas', snapshot);
  const reopened = new SqliteYjsRepository({ path: f.repositoryPath });
  try { expect(await reopened.getCommandRecord('canvas', gone.ok ? gone.commandId : '')).toEqual(persisted); }
  finally { reopened.close(); }
});

it('lists the latest resource edits even when a run has more than 1000 receipts', async () => {
  const f = await fixture();
  const { result } = await f.create('long-run-model', BOX);
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(f.repositoryPath);
  try {
    const source = db.prepare('SELECT resource_edit_json FROM canvas_yjs_commands WHERE canvas_id = ? AND command_id = ?').get('canvas', result.commandId) as { resource_edit_json: string };
    const insert = db.prepare('INSERT INTO canvas_yjs_commands (canvas_id, command_id, payload_hash, revision, changed, actor_id, created_at, resource_edit_json) VALUES (?, ?, ?, ?, 1, ?, ?, ?)');
    db.exec('BEGIN');
    for (let index = 0; index < 1001; index++) insert.run('canvas', `long-${index}`, 'hash', index + 2, 'assistant-world:run', '2026-11-13T00:00:00Z', source.resource_edit_json);
    db.exec('COMMIT');
  } finally { db.close(); }
  const commands = await f.repository.listResourceEditCommands('canvas', 'run');
  expect(commands).toHaveLength(1002);
  expect(commands.at(-1)).toEqual({ commandId: 'long-1000', revision: 1002 });
});

it('atomically edits animation source/config, refuses referenced deletion, supports clear and persists original retry versions', async () => {
  const f = await fixture();
  const { instanceId } = await f.create('model', BOX);
  const target = { areaId: 'area-1' };
  const view = await f.read();
  const script = `motion.instance.tween("${instanceId}", { property: "scale", startTime: 0, endTime: 4, from: [1], to: [2], easing: "linear" });`;
  const animation = await f.edit({ resourceType: 'scene_animation_script', operation: 'create', operationId: 'animation', target, expectedParentVersion: view.sceneArea?.resourceVersion, script, duration: 4, loop: false });
  expect(animation).toMatchObject({ ok: true });
  if (!animation.ok) throw Error(JSON.stringify(animation));
  const modelVersion = (await f.read()).resourceVersions?.[`world_model:${instanceId}`];
  expect(await f.edit({ resourceType: 'world_model', operation: 'delete', operationId: 'delete-referenced', target: { instanceId }, expectedVersion: modelVersion })).toMatchObject({ ok: false, code: 'reference-conflict' });
  const patched = await f.edit({ resourceType: 'scene_animation_script', operation: 'patch', operationId: 'animation-patch', target, expectedVersion: animation.version, edits: [{ oldString: 'endTime: 4', newString: 'endTime: 6' }], patch: { duration: 6 } });
  expect(patched).toMatchObject({ ok: true });
  const current = await f.read();
  expect(current.sceneArea?.animationScript).toMatchObject({ duration: 6, script: expect.stringContaining('endTime: 6') });
  if (!patched.ok) throw Error(JSON.stringify(patched));
  const noop = await f.edit({ resourceType: 'scene_animation_script', operation: 'patch', operationId: 'animation-noop', target, expectedVersion: patched.version, edits: [], patch: { duration: 6 } });
  expect(noop).toMatchObject({ ok: true, noop: true, version: patched.version });
  const appended = await f.edit({ resourceType: 'scene_animation_script', operation: 'append', operationId: 'animation-append', target, expectedVersion: patched.version,
    chunk: `\nmotion.instance.tween("${instanceId}", { property: "position", startTime: 0, endTime: 6, from: [0,0,0], to: [1,0,0], easing: "linear" });` });
  expect(appended).toMatchObject({ ok: true });
  if (!appended.ok) throw Error(JSON.stringify(appended));
  const replaced = await f.edit({ resourceType: 'scene_animation_script', operation: 'replace', operationId: 'animation-replace', target, expectedVersion: appended.version, script });
  expect(replaced).toMatchObject({ ok: true });
  expect((await f.read()).sceneArea?.animationScript).toMatchObject({ duration: 6, script });
  if (!replaced.ok) throw Error(JSON.stringify(replaced));
  const deleted = await f.edit({ resourceType: 'scene_animation_script', operation: 'delete', operationId: 'clear-animation', target, expectedVersion: replaced.version });
  expect(deleted).toMatchObject({ ok: true, deleted: true });
  expect((await f.read()).sceneArea?.animationScript).toBeNull();
});

it('keeps camera edits and retries current, deletes without completion ghosts, and settles automatically', async () => {
  const f = await fixture();
  const created = await f.edit({ resourceType: 'world_camera', operation: 'create', operationId: 'camera', areaId: 'area-1', settings: {
    position: { u: 0, v: -3, h: 2 }, rotation: [0, 0, 0, 1], projection: { kind: 'perspective', verticalFovRadians: 1, nearMeters: 0.1, farMeters: 100 },
    captureMode: { kind: 'static' }, aspect: { width: 16, height: 9 }, boundInstanceId: null
  } });
  expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
  if (!created.ok || !created.target) throw Error(JSON.stringify(created));
  const request = { resourceType: 'world_camera' as const, operation: 'update' as const, operationId: 'camera-update', target: created.target, expectedVersion: created.version, patch: { settings: { lookAt: { u: 0, v: 0, h: 0 } } } };
  const updated = await f.edit(request);
  expect(updated, JSON.stringify(updated)).toMatchObject({ ok: true });
  if (!updated.ok) throw Error(JSON.stringify(updated));
  const second = await f.edit({ ...request, operationId: 'camera-update2', expectedVersion: updated.version, patch: { settings: { position: { u: 2, v: -3, h: 2 } } } });
  expect(second, JSON.stringify(second)).toMatchObject({ ok: true });
  if (!second.ok) throw Error(JSON.stringify(second));
  expect(await f.edit(request)).toEqual({ ...updated, duplicate: true });
  expect((await f.hostCompletions.listCommitted({ canvasId: 'canvas', runId: 'run' }))[0]?.settingsVersion).toBe(second.settingsVersion);
  const removed = await f.edit({ resourceType: 'world_camera', operation: 'delete', operationId: 'camera-delete', target: created.target, expectedVersion: second.version });
  expect(removed, JSON.stringify(removed)).toMatchObject({ ok: true, deleted: true });
  expect(await f.edit(request)).toEqual({ ...updated, duplicate: true });
  const recovered = await f.restart();
  const settled = await recovered.settleRun({ canvasId: 'canvas', runId: 'run', status: 'succeeded', evidence: {} });
  expect(settled, JSON.stringify(settled)).toMatchObject({ ok: true });
  expect(await f.hostCompletions.listCommitted({ canvasId: 'canvas', runId: 'run' })).toHaveLength(0);
  expect(await f.hostCompletions.listIntents({ canvasId: 'canvas', runId: 'run' })).toHaveLength(0);
  const cameraId = 'cameraId' in created.target ? created.target.cameraId : '';
  expect(await f.history.list('canvas', cameraId)).toEqual([expect.objectContaining({ settingsVersion: second.settingsVersion })]);
  expect(await recovered.settleRun({ canvasId: 'canvas', runId: 'run', status: 'succeeded', evidence: {} })).toMatchObject({ ok: true });
  expect(await f.history.list('canvas', cameraId)).toHaveLength(1);
});

it('revokes grouped writes immediately when the run is cancelled', async () => {
  const f = await fixture();
  const { result, instanceId } = await f.create('cancel-model', BOX);
  await f.assistant.cancel({ canvasId: 'canvas', contextId: f.contextId });
  expect(await f.edit({ resourceType: 'world_model', operation: 'delete', operationId: 'cancelled-delete', target: { instanceId }, expectedVersion: result.version })).toMatchObject({ ok: false, code: 'cancelled' });
  const canvas = await f.room.inspectPublished(value => value);
  expect(canvas.ok && canvas.canvas.document.nodes.some(node => node.id === instanceId)).toBe(true);
});

it('does not commit content or expansion when cancelled while compilation is in flight', async () => {
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const execute: typeof executeSceneIr = async (...args) => {
    if (args[0].includes('cancel-during-compile')) { started(); await waiting; }
    return executeSceneIr(...args);
  };
  const f = await fixture(true, undefined, undefined, execute);
  const { instanceId } = await f.create('inflight-model', BOX);
  const before = await f.read();
  const write = f.edit({ resourceType: 'world_model_script', operation: 'replace', operationId: 'inflight-write', target: { instanceId }, expectedVersion: before.resourceVersions?.[`world_model_script:${instanceId}`], script: "// cancel-during-compile\nscene.box({id:'large',size:[24,1,1]});" });
  await entered;
  await f.assistant.cancel({ canvasId: 'canvas', contextId: f.contextId });
  release();
  expect(await write).toMatchObject({ ok: false, code: 'cancelled' });
  const after = await f.room.inspectPublished(value => value);
  if (!after.ok) throw Error('read failed');
  expect(after.canvas.nodeData[instanceId]?.modelScript).toBe(BOX);
  expect(after.canvas.nodeData.area?.sceneArea).toMatchObject({ bounds: before.bounds });
});


it('rejects a complete post-edit model footprint outside the area without writing it', async () => {
  const f = await fixture();
  const { result, instanceId } = await f.create('footprint', BOX);
  const before = await f.read();
  const request = { resourceType: 'world_model_script' as const, operation: 'replace' as const, operationId: 'too-large', target: { instanceId }, expectedVersion: before.resourceVersions?.[`world_model_script:${instanceId}`], script: "scene.box({ id: 'base', size: [24, 1, 1] });" };
  const rejected = await f.edit(request);
  expect(rejected).toMatchObject({ ok: false, code: 'outside-scope', spatialDiagnostic: { bounds: before.bounds, outsideAxes: ['u'] } });
  const after = await f.read();
  expect(after.modelScripts?.[instanceId]).toBe(BOX);
  expect(after.bounds).toEqual(before.bounds);
  expect(result.ok).toBe(true);
});

it.each(['create', 'append', 'patch'] as const)('checks the complete script after %s before committing', async operation => {
  for (const allowed of [false, true]) {
    const f = await fixture(allowed);
    const { instanceId } = await f.create(`script-${operation}-${allowed}`, operation === 'create' ? undefined : BOX);
    const before = await f.read();
    const target = { instanceId };
    const expectedVersion = before.resourceVersions?.[`world_model_script:${instanceId}`];
    const edit: WorldResourceEdit = operation === 'create'
      ? { resourceType: 'world_model_script', operation, operationId: 'spatial-script', target, expectedParentVersion: before.resourceVersions?.[`world_model:${instanceId}`], script: "scene.box({ id: 'large', size: [24, 1, 1] });" }
      : operation === 'append'
        ? { resourceType: 'world_model_script', operation, operationId: 'spatial-script', target, expectedVersion, chunk: "\nscene.box({ id: 'large', size: [24, 1, 1] });" }
        : { resourceType: 'world_model_script', operation, operationId: 'spatial-script', target, expectedVersion, edits: [{ oldString: '[1, 1, 1]', newString: '[24, 1, 1]' }] };
    const result = await f.edit(edit);
    const after = await f.read();
    if (allowed) {
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, sceneArea: { expanded: true } });
      expect(after.bounds!.max.u).toBe(12);
      expect(after.modelScripts?.[instanceId]).toContain('[24, 1, 1]');
    } else {
      expect(result, JSON.stringify(result)).toMatchObject({ ok: false, code: 'outside-scope' });
      expect(after.bounds).toEqual(before.bounds);
      expect(after.modelScripts?.[instanceId]).toBe(before.modelScripts?.[instanceId]);
    }
  }
});

 it('commits a model expansion with the content and replays the frozen receipt', async () => {
  const f = await fixture(true);
  const { instanceId } = await f.create('model', BOX);
  const before = await f.read();
  const request = { resourceType: 'world_model_script' as const, operation: 'replace' as const, operationId: 'expand', target: { instanceId }, expectedVersion: before.resourceVersions?.[`world_model_script:${instanceId}`], script: "scene.box({ id: 'base', size: [24, 1, 1] });" };
  const result = await f.edit(request);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, sceneArea: { expanded: true, bounds: { min: { u: -12, v: -10 }, max: { u: 12, v: 10 } } } });
  expect((await f.read()).modelScripts?.[instanceId]).toBe(request.script);
  if (!result.ok) throw Error(JSON.stringify(result));
  const next = await f.edit({ ...request, operationId: 'expand-again', expectedVersion: result.version, script: "scene.box({ id: 'base', size: [26, 1, 1] });" });
  expect(next, JSON.stringify(next)).toMatchObject({ ok: true, sceneArea: { expanded: true, bounds: { min: { u: -13 }, max: { u: 13 } } } });
  expect(await f.edit(request)).toEqual({ ...result, duplicate: true });
  await f.restart();
  expect(await f.edit(request)).toEqual({ ...result, duplicate: true });
});

it('rolls back the model and area when the added region is occupied by another run', async () => {
  const f = await fixture(true, canvas => {
    canvas.document.nodes.push({ id: 'neighbor', type: 'scene-area', position: { x: 1, y: 1 } });
    canvas.nodeData.neighbor = { title: '邻区', sceneArea: { kind: 'scene-area', version: 'shared-world-v1', areaId: 'area-2', scopeVersion: 'scope-2', bounds: { min: { u: 11, v: -2 }, max: { u: 20, v: 2 } } } } as CanvasNodeData;
  });
  const { instanceId } = await f.create('model', BOX);
  const second = await f.assistant.issue({ canvasId: 'canvas', requestId: 'other', runId: 'other', epoch: 0, executionId: 'other', scope: { kind: 'scene-area', areaId: 'area-2' } });
  expect(second).toMatchObject({ ok: true });
  const before = await f.read();
  const failed = await f.edit({ resourceType: 'world_model_script', operation: 'replace', operationId: 'conflict', target: { instanceId }, expectedVersion: before.resourceVersions?.[`world_model_script:${instanceId}`], script: "scene.box({ id: 'base', size: [24, 1, 1] });" });
  expect(failed).toMatchObject({ ok: false, code: 'lease-conflict' });
  const after = await f.read();
  expect(after.bounds).toEqual(before.bounds);
  expect(after.modelScripts?.[instanceId]).toBe(BOX);
});

it('bounds complete animation motion and keeps its origin fixed when expansion is allowed', async () => {
  for (const allowed of [false, true]) {
    const f = await fixture(allowed);
    const { instanceId } = await f.create(`animated-${allowed}`, BOX);
    const before = await f.read();
    const script = `motion.instance.tween("${instanceId}", { property: "position", startTime: 0, endTime: 3, from: [0,0,0], to: [20,0,0], easing: "easeInOut" });`;
    const result = await f.edit({ resourceType: 'scene_animation_script', operation: 'create', operationId: 'animate', target: { areaId: 'area-1' }, expectedParentVersion: before.sceneArea?.resourceVersion, script, duration: 3, loop: false });
    if (!allowed) {
      expect(result).toMatchObject({ ok: false, code: 'outside-scope', spatialDiagnostic: { areaId: 'area-1', outsideAxes: ['u'] } });
      expect((await f.read()).sceneArea?.animationScript).toBeNull();
    } else {
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, sceneArea: { expanded: true } });
      const after = await f.read();
      expect(after.bounds!.max.u).toBeGreaterThan(20);
      expect(after.sceneArea?.animationOrigin).toEqual(before.sceneArea?.animationOrigin);
      expect(after.sceneArea?.animationScript?.script).toBe(script);
    }
  }
});

it('includes rotating nested parts in the animation envelope', async () => {
  for (const allowed of [false, true]) {
    const f = await fixture(allowed);
    const model = "scene.group({ id: 'joint', position: [0, 0, 0], scale: [1, 2, 1] }); scene.box({ id: 'arm', parent: 'joint', position: [0, 5.5, 0], size: [1, 1, 1] });";
    const { instanceId } = await f.create(`part-${allowed}`, model);
    const before = await f.read();
    const script = `motion.part.tween("${instanceId}", "joint", { property: "rotation", startTime: 0, endTime: 2, from: [0,0,0], to: [0,0,90], easing: "linear" });`;
    const result = await f.edit({ resourceType: 'scene_animation_script', operation: 'create', operationId: 'part-motion', target: { areaId: 'area-1' }, expectedParentVersion: before.sceneArea?.resourceVersion, script, duration: 2, loop: false });
    if (allowed) {
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, sceneArea: { expanded: true } });
      expect((await f.read()).bounds!.min.u).toBeLessThan(-10);
    } else {
      expect(result, JSON.stringify(result)).toMatchObject({ ok: false, code: 'outside-scope' });
      expect((await f.read()).sceneArea?.animationScript).toBeNull();
    }
  }
});

it('checks the complete walk route against the frozen expansion policy', async () => {
  const model = 'scene.segment({id:"abdomen",parent:rig.joint("Spine"),from:[0,-0.5,0],to:[0,0,0],width:0.1});' +
    'for(const side of ["Left","Right"])scene.box({id:side+"Sole",parent:rig.joint(side+"Foot"),position:[0,-0.04,0.08],size:[0.24,0.14,0.38]});';
  for (const allowed of [false, true]) {
    const f = await fixture(allowed);
    const { instanceId } = await f.create(`walker-${allowed}`, model);
    const before = await f.read();
    const profile = before.sceneModels?.find(item => item.instanceId === instanceId)?.animationRig?.walkProfile;
    expect(profile).toBeTruthy();
    const options = { startTime: 0, endTime: 24, path: [[0, 0], [14, 0], [14, 4], [0, 4]], cornerRadius: 0.5, strideLength: 0.6, stepHeight: 0.09, scale: 1, baseYawDegrees: 0, profile };
    const script = `motion.instance.walk(${JSON.stringify(instanceId)},${JSON.stringify(options)});`;
    const result = await f.edit({ resourceType: 'scene_animation_script', operation: 'create', operationId: 'walk', target: { areaId: 'area-1' }, expectedParentVersion: before.sceneArea?.resourceVersion, script, duration: 24, loop: true });
    if (allowed) {
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, sceneArea: { expanded: true } });
      const after = await f.read();
      expect(after.bounds!.max.u).toBeGreaterThan(14);
      expect(after.sceneArea?.animationOrigin).toEqual(before.sceneArea?.animationOrigin);
    } else {
      expect(result, JSON.stringify(result)).toMatchObject({ ok: false, code: 'outside-scope' });
      expect((await f.read()).sceneArea?.animationScript).toBeNull();
    }
  }
});

it('undoes content and expansion together, redoes them, and refuses later dependencies', async () => {
  const f = await fixture(true);
  const { instanceId } = await f.create('undo-model', BOX);
  const before = await f.read();
  const script = "scene.box({ id: 'base', size: [24, 1, 1] });";
  const changed = await f.edit({ resourceType: 'world_model_script', operation: 'replace', operationId: 'undo-source', target: { instanceId }, expectedVersion: before.resourceVersions?.[`world_model_script:${instanceId}`], script });
  if (!changed.ok) throw Error(JSON.stringify(changed));
  expect(await f.assistant.settleRun({ canvasId: 'canvas', runId: 'run', status: 'succeeded', evidence: {} })).toMatchObject({ ok: true });
  const undo = await f.worldAuthoring.replayResourceEdit({ canvasId: 'canvas', sourceCommandId: changed.commandId, previousCommandId: changed.commandId, operationId: 'undo', direction: 'undo' });
  expect(undo, JSON.stringify(undo)).toMatchObject({ ok: true });
  if (!undo.ok) throw Error(JSON.stringify(undo));
  let state = await f.room.inspectPublished(value => value);
  if (!state.ok) throw Error('read failed');
  expect(state.canvas.nodeData.area?.sceneArea).toMatchObject({ bounds: before.bounds });
  expect(state.canvas.nodeData[instanceId]?.modelScript).toBe(BOX);
  const redo = await f.worldAuthoring.replayResourceEdit({ canvasId: 'canvas', sourceCommandId: changed.commandId, previousCommandId: undo.commandId, operationId: 'redo', direction: 'redo' });
  expect(redo, JSON.stringify(redo)).toMatchObject({ ok: true });
  state = await f.room.inspectPublished(value => value);
  if (!state.ok) throw Error('read failed');
  expect(state.canvas.nodeData[instanceId]?.modelScript).toBe(script);
  expect(await f.worldAuthoring.replayResourceEdit({ canvasId: 'canvas', sourceCommandId: changed.commandId, previousCommandId: changed.commandId, operationId: 'stale', direction: 'undo' })).toMatchObject({ ok: false, code: 'version-conflict' });
});

it('restores a created expanding model through undo, redo and a repeated undo', async () => {
  const f = await fixture(true);
  const created = await f.edit({ resourceType: 'world_model', operation: 'create', operationId: 'history-create', areaId: 'area-1', initialScript: BOX,
    transform: { version: 'shared-world-v1', position: { u: 14, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 } });
  if (!created.ok || !created.target || !('instanceId' in created.target)) throw Error(JSON.stringify(created));
  const nodeId = created.target.instanceId;
  expect(await f.assistant.settleRun({ canvasId: 'canvas', runId: 'run', status: 'succeeded', evidence: {} })).toMatchObject({ ok: true });
  const replay = (previousCommandId: string, operationId: string, direction: 'undo' | 'redo') => f.worldAuthoring.replayResourceEdit({ canvasId: 'canvas', sourceCommandId: created.commandId, previousCommandId, operationId, direction });
  const undo = await replay(created.commandId, 'undo-create', 'undo');
  if (!undo.ok) throw Error(JSON.stringify(undo));
  expect(await replay(created.commandId, 'undo-create', 'undo')).toEqual({ ...undo, duplicate: true });
  let state = await f.room.inspectPublished(value => value);
  if (!state.ok) throw Error('read failed');
  expect(state.canvas.nodeData[nodeId]).toBeUndefined();
  expect(state.canvas.nodeData.area?.sceneArea).toMatchObject({ bounds: { max: { u: 10 } } });
  const redo = await replay(undo.commandId, 'redo-create', 'redo');
  if (!redo.ok) throw Error(JSON.stringify(redo));
  state = await f.room.inspectPublished(value => value);
  if (!state.ok) throw Error('read failed');
  expect(state.canvas.nodeData[nodeId]?.modelScript).toBe(BOX);
  expect(state.canvas.nodeData.area?.sceneArea).toMatchObject({ bounds: { max: { u: 14.5 } } });
  expect(await replay(redo.commandId, 'undo-create-again', 'undo')).toMatchObject({ ok: true });
});

it('restores a deleted model with its original content through undo and redo', async () => {
  const f = await fixture();
  const { instanceId } = await f.create('history-delete-model', BOX);
  const view = await f.read();
  const deleted = await f.edit({ resourceType: 'world_model', operation: 'delete', operationId: 'history-delete', target: { instanceId }, expectedVersion: view.resourceVersions?.[`world_model:${instanceId}`] });
  if (!deleted.ok) throw Error(JSON.stringify(deleted));
  expect(await f.assistant.settleRun({ canvasId: 'canvas', runId: 'run', status: 'succeeded', evidence: {} })).toMatchObject({ ok: true });
  const undo = await f.worldAuthoring.replayResourceEdit({ canvasId: 'canvas', sourceCommandId: deleted.commandId, previousCommandId: deleted.commandId, operationId: 'undo-delete', direction: 'undo' });
  if (!undo.ok) throw Error(JSON.stringify(undo));
  const state = await f.room.inspectPublished(value => value);
  if (!state.ok) throw Error('read failed');
  expect(state.canvas.nodeData[instanceId]?.modelScript).toBe(BOX);
  expect(await f.worldAuthoring.replayResourceEdit({ canvasId: 'canvas', sourceCommandId: deleted.commandId, previousCommandId: undo.commandId, operationId: 'redo-delete', direction: 'redo' })).toMatchObject({ ok: true });
});

it('undoes an added title without resetting the model content version', async () => {
  const f = await fixture();
  const created = await f.edit({ resourceType: 'world_model', operation: 'create', operationId: 'untitled-model', areaId: 'area-1', initialScript: BOX,
    transform: { version: 'shared-world-v1', position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 } });
  if (!created.ok || !created.target || !('instanceId' in created.target)) throw Error(JSON.stringify(created));
  const instanceId = created.target.instanceId;
  const view = await f.read();
  const script = await f.edit({ resourceType: 'world_model_script', operation: 'replace', operationId: 'bump-content', target: { instanceId }, expectedVersion: view.resourceVersions?.[`world_model_script:${instanceId}`], script: BOX.replace('#888888', '#336699') });
  if (!script.ok) throw Error(JSON.stringify(script));
  const current = await f.read();
  const renamed = await f.edit({ resourceType: 'world_model', operation: 'update', operationId: 'add-title', target: { instanceId }, expectedVersion: current.resourceVersions?.[`world_model:${instanceId}`], patch: { title: '标题' } });
  if (!renamed.ok) throw Error(JSON.stringify(renamed));
  const before = await f.room.inspectPublished(value => value);
  if (!before.ok) throw Error('read failed');
  const version = before.canvas.nodeData[instanceId]?.modelContentVersion;
  expect(await f.assistant.settleRun({ canvasId: 'canvas', runId: 'run', status: 'succeeded', evidence: {} })).toMatchObject({ ok: true });
  const undo = await f.worldAuthoring.replayResourceEdit({ canvasId: 'canvas', sourceCommandId: renamed.commandId, previousCommandId: renamed.commandId, operationId: 'undo-title', direction: 'undo' });
  expect(undo, JSON.stringify(undo)).toMatchObject({ ok: true });
  const after = await f.room.inspectPublished(value => value);
  if (!after.ok) throw Error('read failed');
  expect(after.canvas.nodeData[instanceId]).not.toHaveProperty('title');
  expect(after.canvas.nodeData[instanceId]?.modelContentVersion).toEqual(version);
  if (!undo.ok) throw Error(JSON.stringify(undo));
  expect(await f.worldAuthoring.replayResourceEdit({ canvasId: 'canvas', sourceCommandId: renamed.commandId, previousCommandId: undo.commandId, operationId: 'redo-title', direction: 'redo' })).toMatchObject({ ok: true });
  const redone = await f.room.inspectPublished(value => value);
  if (!redone.ok) throw Error('read failed');
  expect(redone.canvas.nodeData[instanceId]?.modelContentVersion).toEqual(version);
});

it('undoes a newly introduced rig without reusing an older model content revision', async () => {
  const f = await fixture();
  const { instanceId } = await f.create('rig-history-model', BOX);
  const first = await f.read();
  const rigScript = 'scene.box({id:"body",parent:rig.joint("Spine"),size:[1,1,1]});';
  const changed = await f.edit({ resourceType: 'world_model_script', operation: 'replace', operationId: 'add-rig', target: { instanceId }, expectedVersion: first.resourceVersions?.[`world_model_script:${instanceId}`], script: rigScript });
  if (!changed.ok) throw Error(JSON.stringify(changed));
  const before = await f.room.inspectPublished(value => value);
  if (!before.ok) throw Error('read failed');
  const version = before.canvas.nodeData[instanceId]?.modelContentVersion as { revision: number };
  expect(await f.assistant.settleRun({ canvasId: 'canvas', runId: 'run', status: 'succeeded', evidence: {} })).toMatchObject({ ok: true });
  const undo = await f.worldAuthoring.replayResourceEdit({ canvasId: 'canvas', sourceCommandId: changed.commandId, previousCommandId: changed.commandId, operationId: 'undo-rig', direction: 'undo' });
  expect(undo, JSON.stringify(undo)).toMatchObject({ ok: true });
  const after = await f.room.inspectPublished(value => value);
  if (!after.ok) throw Error('read failed');
  expect(after.canvas.nodeData[instanceId]?.modelScript).toBe(BOX);
  expect(after.canvas.nodeData[instanceId]).not.toHaveProperty('modelRig');
  const undoRevision = (after.canvas.nodeData[instanceId]?.modelContentVersion as { revision: number }).revision;
  expect(undoRevision).toBeGreaterThan(version.revision);
  if (!undo.ok) throw Error(JSON.stringify(undo));
  expect(await f.worldAuthoring.replayResourceEdit({ canvasId: 'canvas', sourceCommandId: changed.commandId, previousCommandId: undo.commandId, operationId: 'redo-rig', direction: 'redo' })).toMatchObject({ ok: true });
  const redone = await f.room.inspectPublished(value => value);
  if (!redone.ok) throw Error('read failed');
  expect(redone.canvas.nodeData[instanceId]?.modelScript).toBe(rigScript);
  expect(redone.canvas.nodeData[instanceId]?.modelRig).toBeDefined();
  expect((redone.canvas.nodeData[instanceId]?.modelContentVersion as { revision: number }).revision).toBeGreaterThan(undoRevision);
});

it('expands for camera anchors and keeps previously ungranted neighboring objects read-only', async () => {
  const f = await fixture(true, canvas => {
    canvas.document.nodes.push({ id: 'neighbor', type: 'scene-area', position: { x: 1, y: 1 } });
    canvas.nodeData.neighbor = { title: '邻区', sceneArea: { kind: 'scene-area', version: 'shared-world-v1', areaId: 'area-2', scopeVersion: 'scope-2', bounds: { min: { u: 11, v: -2 }, max: { u: 20, v: 2 } } } } as CanvasNodeData;
  });
  const other = await f.assistant.issue({ canvasId: 'canvas', requestId: 'neighbor-run', runId: 'neighbor-run', epoch: 0, executionId: 'neighbor-exec', scope: { kind: 'scene-area', areaId: 'area-2' } });
  if (!other.ok) throw Error(JSON.stringify(other));
  const neighbor = await f.assistant.write({ contextId: other.context.contextId, operation: { kind: 'edit-resource', operationId: 'neighbor-model', edit: { resourceType: 'world_model', operation: 'create', operationId: 'neighbor-model', areaId: 'area-2', initialScript: BOX, transform: { version: 'shared-world-v1', position: { u: 12, v: 0, h: 0 }, rotation: [0,0,0,1], scale: 1 } } } });
  if (!neighbor.ok || !neighbor.target) throw Error(JSON.stringify(neighbor));
  expect(await f.assistant.settleRun({ canvasId: 'canvas', runId: 'neighbor-run', status: 'succeeded', evidence: {} })).toMatchObject({ ok: true });
  const camera = await f.edit({ resourceType: 'world_camera', operation: 'create', operationId: 'outside-camera', areaId: 'area-1', settings: { position: { u: 14, v: 0, h: 2 }, rotation: [0,0,0,1], projection: { kind: 'perspective', verticalFovRadians: 1, nearMeters: .1, farMeters: 100 }, captureMode: { kind: 'static' }, aspect: { width: 16, height: 9 }, boundInstanceId: null } });
  expect(camera, JSON.stringify(camera)).toMatchObject({ ok: true, sceneArea: { expanded: true, bounds: { max: { u: 14 } } } });
  expect(await f.edit({ resourceType: 'world_model', operation: 'update', operationId: 'foreign', target: neighbor.target, expectedVersion: neighbor.version, patch: { title: '不允许' } })).toMatchObject({ ok: false, code: 'outside-scope' });
});

it('rejects an outside camera when expansion is disabled and preserves an inside boundary point', async () => {
  const f = await fixture(false);
  const settings = { position: { u: 11, v: 0, h: 2 }, rotation: [0, 0, 0, 1] as [number, number, number, number], projection: { kind: 'perspective' as const, verticalFovRadians: 1, nearMeters: .1, farMeters: 100 }, captureMode: { kind: 'static' as const }, aspect: { width: 16, height: 9 }, boundInstanceId: null };
  const before = await f.read();
  const outside = await f.edit({ resourceType: 'world_camera', operation: 'create', operationId: 'outside-disabled', areaId: 'area-1', settings });
  expect(outside).toMatchObject({ ok: false, code: 'outside-scope', spatialDiagnostic: { outsideAxes: ['u'] } });
  expect((await f.read()).bounds).toEqual(before.bounds);
  const boundary = await f.edit({ resourceType: 'world_camera', operation: 'create', operationId: 'on-boundary', areaId: 'area-1', settings: { ...settings, position: { u: 10, v: 0, h: 2 } } });
  expect(boundary).toMatchObject({ ok: true, sceneArea: { expanded: false, bounds: before.bounds } });
});

it('rolls back content and lease on a storage failure and accepts the original retry', async () => {
  let fail = false;
  const f = await fixture(true, undefined, () => fail);
  const { instanceId } = await f.create('failure-model', BOX);
  const before = await f.read();
  const request = { resourceType: 'world_model_script' as const, operation: 'replace' as const, operationId: 'storage-failure', target: { instanceId }, expectedVersion: before.resourceVersions?.[`world_model_script:${instanceId}`], script: "scene.box({ id: 'base', size: [24, 1, 1] });" };
  fail = true;
  expect(await f.edit(request)).toMatchObject({ ok: false, message: "注入的写失败" });
  fail = false;
  const afterFailure = await f.read();
  expect(afterFailure.bounds).toEqual(before.bounds);
  expect(afterFailure.modelScripts?.[instanceId]).toBe(BOX);
  expect(await f.edit(request)).toMatchObject({ ok: true, sceneArea: { expanded: true } });
});

it('does not commit an expansion when compilation fails or existing geometry is unknown', async () => {
  const reference = normalizeGlbModelReference({ assetId: 'unavailable-asset' });
  if (!reference.ok) throw Error(reference.reason);
  const f = await fixture(true, canvas => {
    canvas.document.nodes.push({ id: 'unknown', type: 'model3d' });
    canvas.nodeData.unknown = { modelSourceKind: 'glb', modelAssetId: 'unavailable-asset', modelContentVersion: reference.value.contentVersion, modelPlacement: reference.value.placement,
      sharedWorldInstance: { kind: 'world-instance', version: 'shared-world-v1', instanceId: 'unknown', transform: { version: 'shared-world-v1', position: { u: 30, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 } } } as CanvasNodeData;
  });
  const { instanceId } = await f.create('unknown-neighbor-model', BOX);
  const before = await f.read();
  const base = { resourceType: 'world_model_script' as const, operation: 'replace' as const, target: { instanceId }, expectedVersion: before.resourceVersions?.[`world_model_script:${instanceId}`] };
  expect(await f.edit({ ...base, operationId: 'bad-compile', script: 'scene.box({' })).toMatchObject({ ok: false });
  expect(await f.edit({ ...base, operationId: 'unknown-expansion', script: "scene.box({id:'big',size:[24,1,1]});" })).toMatchObject({ ok: false, code: 'not-ready' });
  const after = await f.read();
  expect(after.bounds).toEqual(before.bounds);
  expect(after.modelScripts?.[instanceId]).toBe(BOX);
});

it('keeps both content and expansion when an undo cannot be stored, then accepts its retry', async () => {
  let fail = false;
  const f = await fixture(true, undefined, () => fail);
  const { instanceId } = await f.create('undo-failure-model', BOX);
  const before = await f.read();
  const changed = await f.edit({ resourceType: 'world_model_script', operation: 'replace', operationId: 'undo-failure-edit', target: { instanceId }, expectedVersion: before.resourceVersions?.[`world_model_script:${instanceId}`], script: "scene.box({ id: 'base', size: [24,1,1] });" });
  if (!changed.ok) throw Error(JSON.stringify(changed));
  expect(await f.assistant.settleRun({ canvasId: 'canvas', runId: 'run', status: 'succeeded', evidence: {} })).toMatchObject({ ok: true });
  const request = { canvasId: 'canvas', sourceCommandId: changed.commandId, previousCommandId: changed.commandId, operationId: 'undo-failure', direction: 'undo' as const };
  fail = true;
  expect(await f.worldAuthoring.replayResourceEdit(request)).toMatchObject({ ok: false });
  let state = await f.room.inspectPublished(value => value);
  if (!state.ok) throw Error('read failed');
  expect(state.canvas.nodeData[instanceId]?.modelScript).toContain('[24,1,1]');
  expect(state.canvas.nodeData.area?.sceneArea).toMatchObject({ bounds: changed.sceneArea?.bounds });
  fail = false;
  expect(await f.worldAuthoring.replayResourceEdit(request)).toMatchObject({ ok: true });
  state = await f.room.inspectPublished(value => value);
  if (!state.ok) throw Error('read failed');
  expect(state.canvas.nodeData[instanceId]?.modelScript).toBe(BOX);
  expect(state.canvas.nodeData.area?.sceneArea).toMatchObject({ bounds: before.bounds });
});

it('can undo successive dependent expansions in reverse order', async () => {
  const f = await fixture(true);
  const { instanceId } = await f.create('chain-model', BOX);
  const before = await f.read();
  const base = { resourceType: 'world_model_script' as const, operation: 'replace' as const, target: { instanceId } };
  const first = await f.edit({ ...base, operationId: 'first-expansion', expectedVersion: before.resourceVersions?.[`world_model_script:${instanceId}`], script: "scene.box({ id: 'base', size: [24,1,1] });" });
  if (!first.ok) throw Error(JSON.stringify(first));
  const second = await f.edit({ ...base, operationId: 'second-expansion', expectedVersion: first.version, script: "scene.box({ id: 'base', size: [30,1,1] });" });
  if (!second.ok) throw Error(JSON.stringify(second));
  expect(await f.assistant.settleRun({ canvasId: 'canvas', runId: 'run', status: 'succeeded', evidence: {} })).toMatchObject({ ok: true });
  expect(await f.worldAuthoring.replayResourceEdit({ canvasId: 'canvas', sourceCommandId: first.commandId, previousCommandId: first.commandId, operationId: 'too-early', direction: 'undo' })).toMatchObject({ ok: false, code: 'version-conflict' });
  expect(await f.worldAuthoring.replayResourceEdit({ canvasId: 'canvas', sourceCommandId: second.commandId, previousCommandId: second.commandId, operationId: 'undo-second', direction: 'undo' })).toMatchObject({ ok: true });
  const undoFirst = await f.worldAuthoring.replayResourceEdit({ canvasId: 'canvas', sourceCommandId: first.commandId, previousCommandId: first.commandId, operationId: 'undo-first', direction: 'undo' });
  expect(undoFirst, JSON.stringify(undoFirst)).toMatchObject({ ok: true });
  const canvas = await f.room.inspectPublished(value => value);
  if (!canvas.ok) throw Error('read failed');
  expect(canvas.canvas.nodeData[instanceId]?.modelScript).toBe(BOX);
  expect(canvas.canvas.nodeData.area?.sceneArea).toMatchObject({ bounds: before.bounds });
});

it('recovers a frozen receipt from a reopened lease store without restoring write authority', async () => {
  const f = await fixture(true);
  const { instanceId } = await f.create('recover-model', BOX);
  const before = await f.read();
  const edit = { resourceType: 'world_model_script' as const, operation: 'replace' as const, operationId: 'recover-expansion', target: { instanceId }, expectedVersion: before.resourceVersions?.[`world_model_script:${instanceId}`], script: "scene.box({ id: 'base', size: [24,1,1] });" };
  const committed = await f.edit(edit);
  if (!committed.ok) throw Error(JSON.stringify(committed));
  const recovered = f.restartForReceipt();
  const call = (value: typeof edit) => recovered.write({ contextId: f.contextId, operation: { kind: 'edit-resource', operationId: value.operationId, edit: value } });
  expect(await call(edit)).toEqual({ ...committed, duplicate: true });
  expect(await call({ ...edit, script: BOX })).toMatchObject({ ok: false, code: 'operation-conflict' });
  expect(await call({ ...edit, operationId: 'new-edit' })).toMatchObject({ ok: false });
  f.repository.cancelSpatialRun('canvas', 'run');
  expect(await call(edit)).toMatchObject({ ok: false });
});

it('recovers the exact receipt and canvas after all services and the room are reopened', async () => {
  const f = await fixture(true);
  const { instanceId } = await f.create('restart-model', BOX);
  const before = await f.read();
  const edit = { resourceType: 'world_model_script' as const, operation: 'replace' as const, operationId: 'restart-expansion', target: { instanceId }, expectedVersion: before.resourceVersions?.[`world_model_script:${instanceId}`], script: "scene.box({ id: 'base', size: [24,1,1] });" };
  const committed = await f.edit(edit);
  if (!committed.ok) throw Error(JSON.stringify(committed));
  const expected = await f.room.inspectPublished(value => value);
  if (!expected.ok) throw Error('read failed');
  f.stop();
  const authority = createWorldAuthoringAuthority({ executeScene: executeSceneIr, verifyStopped: () => true });
  const repository = new SqliteYjsRepository({ path: f.repositoryPath, spatialAuthority: authority });
  const room = new CanvasRoom({ canvasId: 'canvas', repository });
  closers.push(() => { room.dispose(); repository.close(); });
  expect(await room.load()).toMatchObject({ ok: true });
  const worldAuthoring = createWorldAuthoringService({ authority, resolveRoom: async () => room,
    acquire: async intent => repository.acquireSpatialRun(intent), cancel: async (id, request) => repository.cancelSpatialRun(id, request),
    findLatest: async (id, operationId) => repository.findLatestWorldAuthoringCommand(id, operationId) });
  closers.push(() => worldAuthoring.close());
  const assistant = createAssistantWorldService({ authority, worldAuthoring, resolveRoom: async () => room,
    cameraSettings: { save: async () => { throw Error('unused'); }, complete: async () => { throw Error('unused'); } },
    cancel: async (id, request) => repository.cancelSpatialRun(id, request),
    confirmStopped: async input => repository.confirmSpatialStopped(input.canvasId, input.requestId, input.runId, input.epoch, input.executionId, input.evidence), pending: async () => repository.pendingSpatialRuns() });
  closers.push(() => assistant.close());
  const recovered = await assistant.write({ contextId: f.contextId, operation: { kind: 'edit-resource', operationId: edit.operationId, edit } });
  expect(recovered).toEqual({ ...committed, duplicate: true });
  expect(await assistant.write({ contextId: f.contextId, operation: { kind: 'edit-resource', operationId: 'new-after-restart', edit: { ...edit, operationId: 'new-after-restart' } } })).toMatchObject({ ok: false });
  const reopened = await room.inspectPublished(value => value);
  if (!reopened.ok) throw Error('read failed');
  expect(reopened.canvas).toEqual(expected.canvas);
});

it('undoes and redoes a durable expansion after reopening the room', async () => {
  const f = await fixture(true);
  const { instanceId } = await f.create('reopen-history-model', BOX);
  const before = await f.read();
  const changed = await f.edit({ resourceType: 'world_model_script', operation: 'replace', operationId: 'reopen-history', target: { instanceId }, expectedVersion: before.resourceVersions?.[`world_model_script:${instanceId}`], script: "scene.box({ id: 'base', size: [24,1,1] });" });
  if (!changed.ok) throw Error(JSON.stringify(changed));
  expect(await f.assistant.settleRun({ canvasId: 'canvas', runId: 'run', status: 'succeeded', evidence: {} })).toMatchObject({ ok: true });
  f.stop();
  const authority = createWorldAuthoringAuthority({ executeScene: executeSceneIr, verifyStopped: () => true });
  const repository = new SqliteYjsRepository({ path: f.repositoryPath, spatialAuthority: authority });
  const room = new CanvasRoom({ canvasId: 'canvas', repository });
  closers.push(() => { room.dispose(); repository.close(); });
  expect(await room.load()).toMatchObject({ ok: true });
  const worldAuthoring = createWorldAuthoringService({ authority, resolveRoom: async () => room,
    acquire: async intent => repository.acquireSpatialRun(intent), cancel: async (id, request) => repository.cancelSpatialRun(id, request),
    findLatest: async (id, operationId) => repository.findLatestWorldAuthoringCommand(id, operationId) });
  closers.push(() => worldAuthoring.close());
  const undo = await worldAuthoring.replayResourceEdit({ canvasId: 'canvas', sourceCommandId: changed.commandId, previousCommandId: changed.commandId, operationId: 'reopened-undo', direction: 'undo' });
  if (!undo.ok) throw Error(JSON.stringify(undo));
  let state = await room.inspectPublished(value => value);
  if (!state.ok) throw Error('read failed');
  expect(state.canvas.nodeData[instanceId]?.modelScript).toBe(BOX);
  expect(state.canvas.nodeData.area?.sceneArea).toMatchObject({ bounds: before.bounds });
  const redo = await worldAuthoring.replayResourceEdit({ canvasId: 'canvas', sourceCommandId: changed.commandId, previousCommandId: undo.commandId, operationId: 'reopened-redo', direction: 'redo' });
  expect(redo).toMatchObject({ ok: true });
  state = await room.inspectPublished(value => value);
  if (!state.ok) throw Error('read failed');
  expect(state.canvas.nodeData[instanceId]?.modelScript).toContain('[24,1,1]');
  expect(state.canvas.nodeData.area?.sceneArea).toMatchObject({ bounds: changed.sceneArea?.bounds });
});

it('includes shear from nested nonuniform scales when checking model bounds', async () => {
  const f = await fixture();
  const { instanceId } = await f.create('sheared-model', BOX);
  const before = await f.read();
  const script = "scene.group({ id: 'outer', scale: [10, 1, 1] }); scene.group({ id: 'inner', parent: 'outer', rotation: [0, 45, 0] }); scene.box({ id: 'box', parent: 'inner', size: [2, 2, 2] });";
  const result = await f.edit({ resourceType: 'world_model_script', operation: 'replace', operationId: 'sheared', target: { instanceId }, expectedVersion: before.resourceVersions?.[`world_model_script:${instanceId}`], script });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: false, code: 'outside-scope', spatialDiagnostic: { outsideAxes: ['u'] } });
  expect((await f.read()).modelScripts?.[instanceId]).toBe(BOX);
});

it('expands only to the actual rotated multi-part footprint', async () => {
  const f = await fixture(true);
  const script = "scene.box({id:'a',position:[8,0,8],size:[1,1,1]});scene.box({id:'b',position:[-8,0,-8],size:[1,1,1]});";
  const angle = Math.PI / 8;
  const result = await f.edit({ resourceType: 'world_model', operation: 'create', operationId: 'rotated-parts', areaId: 'area-1', initialScript: script,
    transform: { version: 'shared-world-v1', position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, Math.sin(angle), Math.cos(angle)], scale: 1 } });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, sceneArea: { expanded: true } });
  if (!result.ok || !result.sceneArea) throw Error(JSON.stringify(result));
  expect(result.sceneArea.bounds.max.u).toBeCloseTo(8.5 * Math.SQRT2, 8);
  expect(result.sceneArea.bounds.min.u).toBeCloseTo(-8.5 * Math.SQRT2, 8);
  expect(result.sceneArea.bounds.min.v).toBe(-10);
  expect(result.sceneArea.bounds.max.v).toBe(10);
});

it('does not enlarge a rotated sphere to its rotated bounding cube', async () => {
  const f = await fixture(true);
  const angle = Math.PI / 8;
  const result = await f.edit({ resourceType: 'world_model', operation: 'create', operationId: 'rotated-sphere', areaId: 'area-1',
    initialScript: "scene.sphere({id:'sphere',radius:2});",
    transform: { version: 'shared-world-v1', position: { u: 9, v: 0, h: 0 }, rotation: [0, 0, Math.sin(angle), Math.cos(angle)], scale: 1 } });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, sceneArea: { expanded: true } });
  if (!result.ok || !result.sceneArea) throw Error(JSON.stringify(result));
  expect(result.sceneArea.bounds.max.u).toBeCloseTo(11, 8);
  expect(result.sceneArea.bounds.min.v).toBe(-10);
  expect(result.sceneArea.bounds.max.v).toBe(10);
});
