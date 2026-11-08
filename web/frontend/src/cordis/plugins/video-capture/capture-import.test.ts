import { expect, it, vi } from "vitest";
import { OpenCaptureFrames } from "./capture-frames.js";
import type { MediaRemoteService } from "../../contracts.js";
import type { CanvasSession } from "../../services/canvas-session.js";

it.each(["abort", "dispose", "remove"])("%s during upload prevents late canvas submission", async kind => {
  let finish!:(value:unknown)=>void;
  const upload=vi.fn(()=>new Promise(resolve=>{finish=resolve;}));
  const submitCommands=vi.fn();
  const abort=new AbortController();let exists=true;
  const manager=new OpenCaptureFrames({mediaRemote:{upload} as unknown as MediaRemoteService,
    session:{isWritable:()=>true,submitCommands} as unknown as CanvasSession,
    resolveNodePosition:()=>exists?{x:0,y:0}:null});
  // Node 22 provides File, this test does not decode/render pixels.
  const pending=manager.addFrames([{id:"f",blob:new Blob(["png"]),url:"",selected:true,timeSeconds:1}],"video",abort.signal);
  if(kind==="abort") abort.abort();else if(kind==="dispose") manager.dispose();else exists=false;
  finish({ok:true,media:{storageKey:"key",checksum:"sum",contentType:"image/png",size:3,url:"/api/media/key"}});
  const results=await pending;
  expect(results[0]!.ok).toBe(false);expect(submitCommands).not.toHaveBeenCalled();
});

it("imports a frozen camera frame once with video/version/time provenance and preserves the camera", async () => {
  const upload = vi.fn(async () => ({ ok: true, media: { storageKey: "png-key", checksum: "sum", contentType: "image/png", size: 3, url: "/api/media/png-key" } }));
  const submitCommands = vi.fn((_commands: unknown, _commandId: string) => ({ ok: true }));
  const manager = new OpenCaptureFrames({ mediaRemote: { upload } as unknown as MediaRemoteService,
    session: { isWritable: () => true, submitCommands } as unknown as CanvasSession });
  const frame = { id: "camera-1-time-2", blob: new Blob(["png"]), url: "", selected: true, timeSeconds: 2 };
  const source = { videoAssetId: "frozen-video", videoStorageKey: "video-key", videoUrl: "/api/media/video-key", targetNodeId: "camera",
    cameraSource: { cameraId: "camera", versionKey: { canvasId: "canvas", cameraId: "camera", cameraSettingsVersion: "v1", worldContentVersion: "w1", bindingVersion: "b1", outputVersion: "o1",
      animation: { areaId: "area", scriptRevision: 2, sourceHash: "animation-hash", durationSeconds: 3 },
      timeRange: { startSeconds: 0, endSeconds: 3 }, fps: 24 } } };
  await manager.addFrames([frame], "camera", undefined, source);
  await manager.addFrames([frame], "camera", undefined, source);
  expect(upload).toHaveBeenCalledOnce(); expect(submitCommands).toHaveBeenCalledOnce();
  const commands = submitCommands.mock.calls[0]![0] as Array<{ type: string; nodeId?: string; asset?: { metadata: unknown } }>;
  expect(commands.find(c => c.type === "asset.upsert")!.asset!.metadata).toMatchObject({
    sourceVideoAssetId: "frozen-video", sourceTimeSeconds: 2, sourceCameraId: "camera", sourceCameraVersionKey: JSON.stringify(source.cameraSource.versionKey)
  });
  expect(commands.some(c => c.nodeId === "camera")).toBe(false);
});
