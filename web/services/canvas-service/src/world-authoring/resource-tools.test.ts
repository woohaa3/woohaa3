import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createEmptyWoohaa3ServerCanvas, type WorldResourceEdit, type CanvasNodeData } from '@woohaa3/contracts';
import { CanvasRoom } from '../sync/room.js';
import { SqliteYjsRepository } from '../storage/sqlite/yjs.js';
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
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'world-resources-'));
  closers.push(() => rmSync(directory, { force: true, recursive: true }));
  const canvas = createEmptyWoohaa3ServerCanvas('canvas');
  canvas.document.nodes.push({ id: 'area', type: 'scene-area', position: { x: 0, y: 0 } });
  canvas.nodeData.area = { title: '导演区', sceneArea: { kind: 'scene-area', version: 'shared-world-v1', areaId: 'area-1', scopeVersion: 'scope-1', bounds: { min: { u: -10, v: -10 }, max: { u: 10, v: 10 } } } } as CanvasNodeData;
  const authority = createWorldAuthoringAuthority({ executeScene: executeSceneIr, verifyStopped: () => true });
  const repositoryPath = join(directory, 'canvas.sqlite');
  const repository = new SqliteYjsRepository({ path: repositoryPath, spatialAuthority: authority });
  closers.push(() => repository.close());
  const room = new CanvasRoom({ canvasId: canvas.id, repository });
  await room.initialize({ canvas, roomEpoch: 'epoch', createdAt: new Date().toISOString() });
  closers.push(() => room.dispose());
  const worldAuthoring = createWorldAuthoringService({ authority, resolveRoom: async () => room,
    acquire: async intent => repository.acquireSpatialRun(intent), cancel: async (id, request) => repository.cancelSpatialRun(id, request),
    findLatest: async (id, operationId) => repository.findLatestWorldAuthoringCommand(id, operationId) });
  const history = new InMemoryWorldCameraHistoryRepository();
  let assistant: ReturnType<typeof createAssistantWorldService>;
  const cameraSettings = createWorldCameraSettingsService({ resolveRoom: async () => room, resolveContext: (id, context) => worldAuthoring.resolveCapability(id, context), history,
    verifyCompletion: (completion, evidence) => assistant.verifyCompletion(completion, evidence) });
  const completionPath = join(directory, "completions.sqlite");
  let hostCompletions = new SqliteAssistantHostCompletionRepository({ path: completionPath });
  closers.push(() => hostCompletions.close());
  const makeAssistant = () => createAssistantWorldService({ hostCompletions, authority, worldAuthoring, cameraSettings, resolveRoom: async () => room,
    cancel: async (id, request) => repository.cancelSpatialRun(id, request),
    confirmStopped: async input => repository.confirmSpatialStopped(input.canvasId, input.requestId, input.runId, input.epoch, input.executionId, input.evidence), pending: async () => repository.pendingSpatialRuns() });
  assistant = makeAssistant();
  closers.push(() => assistant.close());
  const issued = await assistant.issue({ canvasId: canvas.id, requestId: 'run', runId: 'run', epoch: 0, executionId: 'exec', scope: { kind: 'scene-area', areaId: 'area-1' } });
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
    const next = await assistant.issue({ canvasId: canvas.id, requestId: 'run', runId: 'run', epoch: 0, executionId: 'exec', scope: { kind: 'scene-area', areaId: 'area-1' } });
    if (!next.ok) throw Error(next.message);
    contextId = next.context.contextId;
    return assistant;
  };
  return { room, assistant, repository, repositoryPath, contextId, edit, read, create, history, get hostCompletions() { return hostCompletions; }, restart };
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

it('updates area bounds/name and model transforms, preserves omitted fields, and rejects unauthorized root lifecycle', async () => {
  const f = await fixture();
  const { instanceId } = await f.create('box', BOX);
  const original = await f.read();
  const resized = await f.edit({ resourceType: 'scene_area', operation: 'update', operationId: 'resize', target: { areaId: 'area-1' }, expectedVersion: original.sceneArea?.resourceVersion,
    patch: { title: '新区域', bounds: { min: { u: -20, v: -20 }, max: { u: 20, v: 20 } } } });
  expect(resized).toMatchObject({ ok: true });
  const after = await f.read();
  expect(after.sceneArea?.title).toBe('新区域');
  expect(after.bounds?.max.u).toBe(20);
  const moved = await f.edit({ resourceType: 'world_model', operation: 'update', operationId: 'move', target: { instanceId }, expectedVersion: after.resourceVersions?.[`world_model:${instanceId}`], patch: { transform: { position: { u: 3, v: 1, h: 0 } } } });
  expect(moved).toMatchObject({ ok: true });
  expect((await f.read()).sceneModels?.[0]?.transform).toMatchObject({ position: { u: 3, v: 1, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 });
  expect(await f.edit({ resourceType: 'scene_area', operation: 'delete', operationId: 'delete-root', target: { areaId: 'area-1' }, expectedVersion: resized.ok ? resized.version : '' })).toMatchObject({ ok: false, code: 'outside-scope' });
  expect(await f.edit({ resourceType: 'world_model', operation: 'update', operationId: 'outside', target: { instanceId: 'foreign' }, expectedVersion: 'v1', patch: { title: 'foreign' } })).toMatchObject({ ok: false, code: 'outside-scope' });
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

it('moves and rotates the area with its real members and rejects concurrent stale updates', async () => {
  const f = await fixture();
  const { instanceId } = await f.create('move-model', BOX);
  const target = { areaId: 'area-1' };
  const original = await f.read();
  const moved = await f.edit({ resourceType: 'scene_area', operation: 'update', operationId: 'move-area', target, expectedVersion: original.sceneArea?.resourceVersion, patch: { moveBy: { u: 3, v: 2 } } });
  expect(moved, JSON.stringify(moved)).toMatchObject({ ok: true });
  const after = await f.read();
  expect(after.sceneModels?.[0]?.transform.position).toEqual({ u: 3, v: 2, h: 0 });
  expect(after.bounds?.min).toEqual({ u: -7, v: -8 });
  expect(after.resourceVersions?.[`world_model_script:${instanceId}`]).toBe(original.resourceVersions?.[`world_model_script:${instanceId}`]);
  const rotated = await f.edit({ resourceType: 'scene_area', operation: 'update', operationId: 'rotate-area', target, expectedVersion: after.sceneArea?.resourceVersion, patch: { rotateClockwise: true } });
  expect(rotated, JSON.stringify(rotated)).toMatchObject({ ok: true });
  const view = await f.read();
  const mutation = { resourceType: 'world_model' as const, operation: 'update' as const, target: { instanceId }, expectedVersion: view.resourceVersions?.[`world_model:${instanceId}`] };
  const results = await Promise.all([f.edit({ ...mutation, operationId: 'first', patch: { title: 'First' } }), f.edit({ ...mutation, operationId: 'second', patch: { title: 'Second' } })]);
  expect(results.filter(result => result.ok)).toHaveLength(1);
  expect(results.filter(result => !result.ok)).toEqual([expect.objectContaining({ code: 'version-conflict' })]);
});


it('revokes grouped writes immediately when the run is cancelled', async () => {
  const f = await fixture();
  const { result, instanceId } = await f.create('cancel-model', BOX);
  await f.assistant.cancel({ canvasId: 'canvas', contextId: f.contextId });
  expect(await f.edit({ resourceType: 'world_model', operation: 'delete', operationId: 'cancelled-delete', target: { instanceId }, expectedVersion: result.version })).toMatchObject({ ok: false, code: 'cancelled' });
  const canvas = await f.room.inspectPublished(value => value);
  expect(canvas.ok && canvas.canvas.document.nodes.some(node => node.id === instanceId)).toBe(true);
});

it('recovers each camera in one area transform from separate durable intents', async () => {
  const f = await fixture();
  const cameras: string[] = [];
  for (let index = 0; index < 2; index++) {
    const created = await f.edit({ resourceType: 'world_camera', operation: 'create', operationId: `camera-${index}`, areaId: 'area-1', settings: {
      position: { u: index, v: -3, h: 2 }, lookAt: { u: 0, v: 0, h: 0 }, projection: { kind: 'perspective', verticalFovRadians: 1, nearMeters: 0.1, farMeters: 100 },
      captureMode: { kind: 'static' }, aspect: { width: 16, height: 9 }, boundInstanceId: null
    } });
    if (!created.ok || !created.cameraId) throw Error(JSON.stringify(created));
    cameras.push(created.cameraId);
  }
  const view = await f.read();
  const moved = await f.edit({ resourceType: 'scene_area', operation: 'update', operationId: 'move-cameras', target: { areaId: 'area-1' }, expectedVersion: view.sceneArea?.resourceVersion, patch: { moveBy: { u: 2, v: 1 } } });
  expect(moved, JSON.stringify(moved)).toMatchObject({ ok: true });
  const versions = (await f.read()).sceneCameras!.map(camera => camera.settings.settingsVersion);
  const intents = (await f.hostCompletions.listIntents()).filter(intent => intent.receiptCommandId === (moved.ok ? moved.commandId : ''));
  expect(intents).toHaveLength(2);
  // Simulate a crash after canonical commit but before outbox persistence.
  for (const write of await f.hostCompletions.listCommitted()) await f.hostCompletions.deleteCommitted(write);
  const recovered = await f.restart(false);
  const settled = await recovered.settleRun({ canvasId: 'canvas', runId: 'run', status: 'succeeded', evidence: {} });
  expect(settled, JSON.stringify(settled)).toMatchObject({ ok: true });
  for (const [index, cameraId] of cameras.entries()) expect(await f.history.list('canvas', cameraId)).toEqual([expect.objectContaining({ settingsVersion: versions[index] })]);
});
