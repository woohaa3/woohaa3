/**
 * 仅 DEV 的视频诊断开关测试（临时 A/B 工具，见 dev-media-switches.ts）。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import {
  DEV_NO_VIDEO_PARAM,
  hasMismatchedFlagIn,
  isDevVideoDisabled,
  withoutVideoMediaSources,
  withoutVideoNodes
} from "./dev-media-switches.js";
import type { CompositeAssetMediaSource } from "../../../extension-api/composite-assets.js";

function canvasWith(types: string[]): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  return {
    ...base,
    revision: 1,
    document: {
      ...base.document,
      nodes: types.map((type, index) => ({ id: `n${index}`, type, position: { x: index, y: 0 } }))
    }
  };
}

function medium(kind: CompositeAssetMediaSource["kind"], index: number): CompositeAssetMediaSource {
  return {
    planeId: `plane-${index}`,
    nodeId: `node-${index}`,
    assetId: `asset-${index}`,
    kind,
    sourceIdentity: `identity-${index}`
  };
}

describe("isDevVideoDisabled", () => {
  it("只在 DEV 且参数为 1 时开启", () => {
    expect(isDevVideoDisabled({ search: `?${DEV_NO_VIDEO_PARAM}=1`, dev: true })).toBe(true);
    expect(isDevVideoDisabled({ search: `?foo=bar&${DEV_NO_VIDEO_PARAM}=1`, dev: true })).toBe(true);
  });

  it("支持 hash 里的 query 与父框架片段", () => {
    expect(isDevVideoDisabled({ hash: `#/canvas?${DEV_NO_VIDEO_PARAM}=1`, dev: true })).toBe(true);
    expect(isDevVideoDisabled({ fragments: ["?realm=abc", `?${DEV_NO_VIDEO_PARAM}=1`], dev: true })).toBe(true);
  });

  it("支持存储键（URL 被重写时的后备）", () => {
    expect(isDevVideoDisabled({ stored: true, dev: true })).toBe(true);
    expect(isDevVideoDisabled({ search: "", stored: false, dev: true })).toBe(false);
  });

  it("值不是 1、缺参数或非 DEV 时不开", () => {
    expect(isDevVideoDisabled({ search: `?${DEV_NO_VIDEO_PARAM}=0`, dev: true })).toBe(false);
    expect(isDevVideoDisabled({ search: `?${DEV_NO_VIDEO_PARAM}=`, dev: true })).toBe(false);
    expect(isDevVideoDisabled({ search: "?other=1", dev: true })).toBe(false);
    expect(isDevVideoDisabled({ search: "", dev: true })).toBe(false);
    expect(isDevVideoDisabled({ search: `?${DEV_NO_VIDEO_PARAM}=1`, dev: false })).toBe(false);
  });
});

describe("hasMismatchedFlagIn", () => {
  it("只对「参数在但值不是 1」为真", () => {
    expect(hasMismatchedFlagIn(`?${DEV_NO_VIDEO_PARAM}=0`)).toBe(true);
    expect(hasMismatchedFlagIn(`?${DEV_NO_VIDEO_PARAM}=`)).toBe(true);
    expect(hasMismatchedFlagIn(`?${DEV_NO_VIDEO_PARAM}=1`)).toBe(false);
    expect(hasMismatchedFlagIn("?other=1")).toBe(false);
    expect(hasMismatchedFlagIn("")).toBe(false);
  });
});

describe("withoutVideoNodes", () => {
  it("去掉视频节点、保留其它节点，且不改动原画布", () => {
    const canvas = canvasWith(["video", "image", "video"]);
    const view = withoutVideoNodes(canvas);
    expect(view?.document.nodes.map((node) => node.id)).toEqual(["n1"]);
    expect(canvas.document.nodes.map((node) => node.id)).toEqual(["n0", "n1", "n2"]);
  });

  it("没有视频节点时原样返回；null 仍是 null", () => {
    const canvas = canvasWith(["image"]);
    expect(withoutVideoNodes(canvas)).toBe(canvas);
    expect(withoutVideoNodes(null)).toBeNull();
  });
});

describe("withoutVideoMediaSources", () => {
  it("只去掉视频源", () => {
    const sources = [medium("video", 0), medium("image", 1), medium("video", 2)];
    expect(withoutVideoMediaSources(sources).map((source) => source.assetId)).toEqual(["asset-1"]);
    expect(sources).toHaveLength(3);
  });
});
