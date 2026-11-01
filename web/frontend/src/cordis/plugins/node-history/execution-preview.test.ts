import { expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas, readBody, type CanvasOperationRecord, type NodeGenerationHistoryListItem } from "@woohaa3/contracts";
import { ExecutionPreview } from "./execution-preview.js";
import { applyRunStateProjection } from "../canvas-shell/run-state-projection.js";
import { setAppBasePathForTesting } from "../../services/app-base-path.js";
import { resolveNodeVideoSource } from "../canvas-runtime/video-source.js";

const operation = (id: string, state: CanvasOperationRecord["state"] = "running", time = id) =>
  ({ nodeId: "n", operationId: id, state, createdAt: time, updatedAt: time, canvasId: "c", kind: "image", owner: "server" } as CanvasOperationRecord);
const version = (id: string, current = false): NodeGenerationHistoryListItem => ({ entryId: id, kind: "image", createdAt: id,
  current, recoverable: true, previewable: true, source: { runId: id, label: id }, preview: { kind: "image", href: `/api/canvas-node-history/c/n/${id}/preview` } });
const canvas = () => {
  const result = createEmptyWoohaa3ServerCanvas("c");
  result.document.nodes.push({ id: "n", type: "image", position: { x: 0, y: 0 } });
  result.nodeData.n = { outputAssetId: "canonical", activeRunId: "b", taskStatus: "processing", progress: 70 };
  return result;
};
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

it("selects each new task, keeps every active dot, and returns to the old image without changing canonical", () => {
  const history = new Map([["n", [version("old", true)]]]);
  const selection = new ExecutionPreview(() => history, vi.fn());
  const records = [operation("a", "running", "1"), operation("b", "queued", "2")];
  selection.observe(records);
  expect(selection.selected.get("n")).toBe("operation:b");
  const node = { id: "n", busy: true, progress: 70 } as never;
  const project = () => applyRunStateProjection([node], { records, summaries: [], versionsByNode: history, selectedByNode: selection.selected });
  project();
  expect(node).toMatchObject({ busy: true, historyStrip: { dots: [{selected:false}, {selected:true}, {selected:false}] } });
  selection.select("n", "operation:old");
  project();
  expect(node).toMatchObject({ busy: false, progress: 0 });
  const original = canvas(), preview = selection.project(original)!;
  expect(preview.nodeData.n.outputAssetId).toBe("history-preview:old");
  expect(original.nodeData.n).toMatchObject({ outputAssetId: "canonical", activeRunId: "b", taskStatus: "processing" });
  records[1] = operation("b", "succeeded", "2");
  selection.observe(records); history.set("n", [version("old"), version("b", true)]);
  expect(selection.selected.get("n")).toBe("operation:old");
  expect(selection.project(original)!.nodeData.n.outputAssetId).toBe("history-preview:old");
  selection.observe([...records, operation("c", "queued", "3")]);
  // 显式选中的旧版本不会被新运行任务抢走；只有没有选择时才自动跟随新任务。
  expect(selection.selected.get("n")).toBe("operation:old");
  selection.dispose();
});

it("holding canonical current keeps a running task from stealing the view", () => {
  const history = new Map([["n", [version("old", true)]]]);
  const selection = new ExecutionPreview(() => history, vi.fn());
  selection.select("n", "operation:old");
  selection.hold("n");
  expect(selection.selected.get("n")).toBeUndefined();
  selection.observe([operation("running-task")]);
  expect(selection.selected.get("n")).toBeUndefined();
  selection.dispose();
});

it("renders a selected operation failure before its archive arrives", () => {
  const history = new Map([["n", [version("old", true)]]]);
  const selection = new ExecutionPreview(() => history, vi.fn());
  selection.select("n", "operation:run");
  selection.setOperationFailure("n", "run", "failed", "模型调用失败");
  const projected = selection.project(canvas())!.nodeData.n as Record<string, unknown>;
  expect(projected.historyPreviewFailure).toEqual({ outcome: "failed", message: "模型调用失败" });
  expect(projected.outputAssetId).toBeUndefined();
  selection.dispose();
});
it("preserves selected operation identity as a non-current result archives after a newer task", async () => {
  const history = new Map<string, NodeGenerationHistoryListItem[]>();
  const detail = vi.fn(async () => ({ ok: true as const, detail: {entryId:"a",kind:"image" as const,storageKey:"key-a",checksum:"checksum",contentType:"image/png",size:4} }));
  const selection = new ExecutionPreview(() => history, vi.fn(), {detail} as never, "c");
  selection.observe([operation("a")]);
  selection.observe([operation("a", "succeeded")]);
  history.set("n", [version("a"), version("b", true)]); selection.refresh(); await flush();
  expect(selection.selected.get("n")).toBe("operation:a");
  expect(selection.project(canvas())!.assets.at(-1)).toMatchObject({url:"/api/media/key-a",metadata:{storageKey:"key-a"}});
  selection.dispose();
});

it("retains an explicitly selected old success when a full recent summary rolls past it", () => {
  const history=new Map([["n",[version("old")]]]);
  const selection=new ExecutionPreview(()=>history,vi.fn());selection.select("n","operation:old");
  const next=new Map([["n",Array.from({length:24},(_,i)=>version(`new-${i}`))]]);
  selection.retain(next);expect(next.get("n")!.some(item=>item.entryId==="old")).toBe(true);
  const cleared=new Map([["n",[]]]);selection.retain(cleared);expect(cleared.get("n")).toEqual([]);
  selection.dispose();
});

it("isolates late detail, failed detail and disposal, and maps a proxy preview only once", async () => {
  setAppBasePathForTesting("/dev/test/");
  try {
    const history = new Map([["n", [{...version("old"),preview:{kind:"image" as const,href:"/dev/test/api/canvas-node-history/c/n/old/preview"}}]]]);
    let release!: (value: unknown) => void;
    const detail = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const changed = vi.fn(), report = vi.fn();
    const selection = new ExecutionPreview(() => history, changed, {detail} as never, "c", report);
    selection.select("n", "operation:old");
    expect(selection.project(canvas())!.assets.at(-1)?.url).toBe("/api/canvas-node-history/c/n/old/preview");
    selection.clear("n");
    selection.observe([operation("new")]);
    release({ok:true,detail:{entryId:"old",kind:"text",text:"late"}});await flush();
    expect(selection.project(canvas())!.nodeData.n.outputAssetId).toBe("canonical");
    detail.mockResolvedValueOnce({ok:false,error:"missing"});
    selection.select("n", "operation:old");await flush();expect(report).toHaveBeenCalledTimes(1);
    selection.refresh();selection.dispose();const calls=changed.mock.calls.length;
    release({ok:true,detail:{entryId:"old",kind:"text",text:"disposed"}});await flush();
    expect(changed).toHaveBeenCalledTimes(calls);
  } finally { setAppBasePathForTesting("/"); }
});

it("shows the selected failure reason in the node card instead of the previous success preview", () => {
  const failure: NodeGenerationHistoryListItem = {
    entryId: "bad", kind: "video", createdAt: "2", outcome: "failed", current: false,
    recoverable: false, previewable: false, source: { runId: "bad", label: "视频生成" },
    preview: { kind: "failure", outcome: "failed", message: "provider 超时" }
  };
  const history = new Map([["n", [version("old", true), failure]]]);
  const selection = new ExecutionPreview(() => history, vi.fn());
  selection.select("n", "operation:bad");
  const original = canvas();
  original.document.nodes[0]!.type = "video";
  const preview = selection.project(original)!;
  expect(preview.nodeData.n?.outputAssetId).toBeUndefined();
  expect(preview.nodeData.n?.historyPreviewFailure).toEqual({ outcome: "failed", message: "provider 超时" });
  expect(readBody("video", preview.nodeData.n, new Map())).toBe("失败：provider 超时");
  expect(original.nodeData.n).toMatchObject({ outputAssetId: "canonical" });
  selection.dispose();
});

it("loads stable video metadata via protected detail without relaxing canonical media validation", async () => {
  const history = new Map([["n", [{...version("v"),kind:"video" as const,preview:{kind:"video" as const,href:"/api/canvas-node-history/c/n/v/preview",posterHref:null,durationSeconds:3}}]]]);
  const selection = new ExecutionPreview(() => history, vi.fn(), {detail:async()=>({ok:true,detail:{entryId:"v",kind:"video",storageKey:"video-key",checksum:"checksum",contentType:"video/mp4",size:9,durationSeconds:3}})} as never, "c");
  selection.select("n", "operation:v");await flush();
  const original=canvas();original.document.nodes[0]!.type="video";
  expect(resolveNodeVideoSource(selection.project(original),"n")).toEqual({url:"/api/media/video-key?canvas=c",posterUrl:null});
  selection.dispose();
});
