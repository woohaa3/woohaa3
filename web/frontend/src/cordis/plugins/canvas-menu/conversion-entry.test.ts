import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ canvas: { id: "c", document: { nodes: [{ id: "m", type: "model3d" }] }, nodeData: {} } as any }));
vi.mock("../../services/canvas-state/index.js", () => ({
  workingCanvasOf: () => state.canvas,
  woohaa3CanvasStore: { getState: () => ({}) }
}));
import { canvasMenuExtension } from "./plugin.js";
import { canvasPointToGround } from "@woohaa3/contracts";

it("submits creation menu actions and routes upload through the import service", async () => {
  let menu: any;
  const record = vi.fn().mockResolvedValue({ ok: true });
  const selectNode = vi.fn((_nodeId: string) => true);
  const requestFile = vi.fn();
  let writable = true;
  canvasMenuExtension({
    slots: { register: (slot: string, value: unknown) => { if (slot === "canvas.context-menu") menu = value; return () => {}; } },
    canvasNavigation: { registerMenu: () => () => {} }, canvasSession: { isWritable: () => writable },
    canvasEdit: { record }, canvasRuntime: { controller: () => ({ selectNode }) },
    dialogs: { open: vi.fn() }, effect: () => {}, get: (key: string) => key === "slots" ? { list: () => [] } : { requestFile }
  } as never, undefined);
  const context = { writable: true, world: { x: 128, y: 64 } };
  const items = menu.items(context);
  expect(items.map((item: any) => item.id)).toEqual(expect.arrayContaining(["insert-scope:group", "insert-scope:area", "upload"]));
  menu.onSelect("insert-scope:group", context);
  menu.onSelect("insert-scope:group", context);
  menu.onSelect("insert-scope:area", context);
  menu.onSelect("insert-scope:area", context);
  const model = items.find((item: any) => /model3d/i.test(item.id));
  expect(model).toBeDefined();
  menu.onSelect(model.id, context);
  menu.onSelect(model.id, context);
  menu.onSelect("upload", context);
  await Promise.resolve();
  expect(requestFile).toHaveBeenCalledWith({ world: context.world });
  expect(record).toHaveBeenCalledTimes(6);
  const data = record.mock.calls.map(call => call[0].find((command: any) => command.type === "node.add").nodeData);
  const groups = data.slice(0, 2).map(d => d.workflowGroup2d);
  const areas = data.slice(2, 4).map(d => d.sceneArea);
  const models = data.slice(4).map(d => d.sharedWorldInstance);
  expect(new Set(groups.map(d => d.groupId)).size).toBe(2);
  expect(new Set(areas.map(d => d.areaId)).size).toBe(2);
  expect(new Set([...groups, ...areas].map(d => d.scopeVersion)).size).toBe(4);
  expect(new Set(models.map(d => d.instanceId)).size).toBe(2);
  const ground = canvasPointToGround(context.world);
  for (const area of areas) expect(area.bounds).toEqual({ min: { u: ground.u - 2, v: ground.v - 2 }, max: { u: ground.u + 2, v: ground.v + 2 } });
  for (const model of models) expect(model.transform.position).toEqual({ ...ground, h: 0 });
  const createdIds = record.mock.calls.map(call => call[0].find((command: any) => command.type === "node.add").node.id);
  await vi.waitFor(() => expect(selectNode).toHaveBeenCalledTimes(createdIds.length));
  expect(new Set(selectNode.mock.calls.map(call => call[0]))).toEqual(new Set(createdIds));
  writable = false;
  menu.onSelect("insert-scope:area", context);
  menu.onSelect("upload", context);
  expect(record).toHaveBeenCalledTimes(6);
  expect(requestFile).toHaveBeenCalledTimes(1);
  expect(selectNode).toHaveBeenCalledTimes(createdIds.length);
});
