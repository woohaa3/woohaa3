import { it, expect } from "vitest";
import { materializeStableMediaResult } from "../src/worker/media-materialization.js";
import { extensionForMediaType, isAllowedMediaType } from "@woohaa3/contracts";
it("adopts motion NPZ with metadata and never projects it as an image", async () => {
  const rows: Record<string, unknown>[] = [];
  const motion = {
    fps: 30,
    frameCount: 90,
    skeletonId: "somaskel77",
    restPoseId: "kimodo-standard-tpose",
    formatVersion: "kimodo-soma-v1",
  };
  const media = {
    storageKey: `generation-outputs/${"c".repeat(64)}.npz`,
    contentType: "application/x-npz",
    size: 620318,
    checksum: "c".repeat(64),
    motion,
  };
  const options = {
    taskStore: { find: async () => null },
    history: {
      upsertRecord: (r: Record<string, unknown>) => {
        rows.push(r);
        return 1;
      },
      lastEventTail: () => undefined,
      lastEvent: () => undefined,
      appendEvent: () => 1,
    },
    mediaClient: {
      verify: async () => ({
        exists: true,
        matches: true,
        metadata: { ...media, mediaKind: "other" },
      }),
    },
  };
  const record = {
    id: "motion-task",
    providerId: "remote-server",
    modelType: "motion",
    state: "succeeded",
    events: [],
    createdAt: "2026-11-12",
    updatedAt: "2026-11-12",
    durationMs: 1000,
    result: { value: { media }, outputs: [] },
  };
  await materializeStableMediaResult(
    options as never,
    record as never,
    undefined,
    media,
  );
  expect(rows.at(-1)).toMatchObject({
    state: "succeeded",
    result: {
      mediaKind: "motion",
      storageKey: media.storageKey,
      contentType: "application/x-npz",
      fps: 30,
      motion,
    },
  });
  expect(isAllowedMediaType("application/x-npz")).toBe(true);
  expect(extensionForMediaType("application/x-npz")).toBe("npz");
});
it('fails malformed generated motion metadata before stable adoption',async()=>{
 const rows:Record<string,unknown>[]=[];let verified=false;
 const media={storageKey:`generation-outputs/${'c'.repeat(64)}.npz`,contentType:'application/x-npz',size:100,checksum:'c'.repeat(64)};
 const options={taskStore:{find:async()=>null},history:{upsertRecord:(r:Record<string,unknown>)=>{rows.push(r);return 1;},lastEventTail:()=>undefined,lastEvent:()=>undefined,appendEvent:()=>1},mediaClient:{verify:async()=>{verified=true;return {exists:true,matches:true,metadata:{...media,mediaKind:'other'}};}}};
 const record={id:'bad-motion',providerId:'remote-server',modelType:'motion',state:'succeeded',events:[],createdAt:'2026-11-12',updatedAt:'2026-11-12',durationMs:1000};
 await materializeStableMediaResult(options as never,record as never,undefined,media);
 expect(verified).toBe(false);expect(rows.at(-1)).toMatchObject({state:'failed',result:{mediaKind:'motion'},error:{code:'motion-metadata-invalid'}});
});
import {resultFromMedia} from '../src/worker/media-materialization.js';
it('cannot publish a generated NPZ summary without canonical motion metadata',()=>{
 expect(()=>resultFromMedia({storageKey:`generation-outputs/${'c'.repeat(64)}.npz`,contentType:'application/x-npz',size:100,checksum:'c'.repeat(64)})).toThrow(/canonical metadata/);
});
