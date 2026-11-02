/**
 * 参考输入落到哪个字段（主图 / 参考图）。
 *
 * 背景：ppserver 的一个模板可能同时声明「主图」`3_image`（上限 1）与「参考图」`1x_image`（上限 9），
 * 两条绑定的 roles / mediaKinds 完全一样。只取第一个匹配会让第二张图撞上主图上限 1，
 * 表现为明明能收 10 张、界面却报「参考输入数量 2 超过上限 1」。
 *
 * 两条链路各测一遍：Canvas 权威解析写进 `input.field`，Task 再按该字段写进 provider payload。
 */
import { describe, expect, it } from "vitest";
import type { CanvasTaskInput, CanvasTaskInputBinding, TaskSubmitRequest } from "@woohaa3/contracts";
import { pickInputBinding } from "@woohaa3/contracts";
import { buildInput } from "../src/composition/provider-input.js";

const STORAGE = (seed: string) => `sha256-${seed.repeat(64)}`;

const BINDINGS: CanvasTaskInputBinding[] = [
  {
    field: "3_image",
    semantic: "reference-image",
    roles: ["reference_image"],
    mediaKinds: ["image"],
    mediaTypes: ["image/png", "image/jpeg", "image/webp"],
    maxItems: 1,
    valueFormat: "url"
  },
  {
    field: "1x_image",
    semantic: "reference-image",
    roles: ["reference_image"],
    mediaKinds: ["image"],
    mediaTypes: ["image/png", "image/jpeg", "image/webp"],
    maxItems: 9,
    valueFormat: "url"
  }
];

const IMAGE = { role: "reference_image", mediaKind: "image" as const, mediaType: "image/png" };

function input(seed: string, field?: string): CanvasTaskInput {
  return {
    assetId: `asset-${seed}`,
    role: "reference_image",
    storageKey: STORAGE(seed),
    mediaType: "image/png",
    mediaKind: "image",
    ...(field ? { field } : {})
  };
}

function request(inputs: CanvasTaskInput[]): TaskSubmitRequest {
  return {
    workerTaskKey: "k",
    canvasId: "c",
    nodeId: "n",
    runId: "r",
    jobId: "j",
    nodeType: "image",
    modelType: "image",
    modelKey: "ppserver:tpl",
    prompt: "变成黑色的",
    parameters: { model: "ppserver:tpl" },
    inputs
  };
}

describe("pickInputBinding：按剩余容量挑字段", () => {
  it("第一张进主图，第二张自动进参考图", () => {
    const used = new Map<string, number>();
    const first = pickInputBinding(BINDINGS, IMAGE, used)!;
    expect(first.field).toBe("3_image");
    used.set(first.field, 1);
    expect(pickInputBinding(BINDINGS, IMAGE, used)!.field).toBe("1x_image");
  });

  it("参考图还有余量时继续进参考图，不会回到主图", () => {
    const used = new Map<string, number>([["3_image", 1], ["1x_image", 1]]);
    expect(pickInputBinding(BINDINGS, IMAGE, used)!.field).toBe("1x_image");
  });

  it("全部满了仍返回第一个候选，让调用方报「上限」而不是「不接受」", () => {
    const used = new Map<string, number>([["3_image", 1], ["1x_image", 9]]);
    expect(pickInputBinding(BINDINGS, IMAGE, used)!.field).toBe("3_image");
  });

  it("角色或媒体类别不匹配时不返回任何绑定", () => {
    expect(pickInputBinding(BINDINGS, { ...IMAGE, role: "first_frame" })).toBeUndefined();
    expect(pickInputBinding(BINDINGS, { ...IMAGE, mediaKind: "video" })).toBeUndefined();
  });

  it("只有一个 urls 字段的模型（ark/grsai）行为不变", () => {
    const single: CanvasTaskInputBinding[] = [{ ...BINDINGS[1]!, field: "urls", maxItems: 8 }];
    const used = new Map<string, number>();
    expect(pickInputBinding(single, IMAGE, used)!.field).toBe("urls");
    used.set("urls", 8);
    expect(pickInputBinding(single, IMAGE, used)!.field).toBe("urls");
  });
});

describe("buildInput：图片模型按字段写参考图", () => {
  const urls = ["https://cdn.example/a.png", "https://cdn.example/b.png"];

  it("两张图分别写进主图与参考图字段", () => {
    const body = buildInput(request([input("a", "3_image"), input("b", "1x_image")]), urls);
    expect(body).toMatchObject({
      prompt: "变成黑色的",
      "3_image": ["https://cdn.example/a.png"],
      "1x_image": ["https://cdn.example/b.png"]
    });
    // 不能再额外冒出通用 urls，否则服务端可能把它当成第三个字段。
    expect(body.urls).toBeUndefined();
  });

  it("同一字段的多张图按提交顺序累积", () => {
    const body = buildInput(
      request([input("a", "1x_image"), input("b", "1x_image"), input("c", "1x_image")]),
      ["https://cdn.example/a.png", "https://cdn.example/b.png", "https://cdn.example/c.png"]
    );
    expect(body["1x_image"]).toEqual([
      "https://cdn.example/a.png",
      "https://cdn.example/b.png",
      "https://cdn.example/c.png"
    ]);
  });

  it("没有任何字段归属时保持旧形状 urls", () => {
    const body = buildInput(request([input("a"), input("b")]), urls);
    expect(body.urls).toEqual(urls);
    expect(body["3_image"]).toBeUndefined();
  });

  it("字段名就是 urls 时结果与旧形状一致（ark / grsai）", () => {
    const body = buildInput(request([input("a", "urls"), input("b", "urls")]), urls);
    expect(body.urls).toEqual(urls);
    expect(Object.keys(body).sort()).toEqual(["model", "prompt", "urls"]);
  });

  it("有字段与无字段混在一起时不塞进 urls，并报出被丢弃的数量", () => {
    let dropped = 0;
    const body = buildInput(
      request([input("a", "3_image"), input("b")]),
      urls,
      (count) => {
        dropped = count;
      }
    );
    expect(body["3_image"]).toEqual(["https://cdn.example/a.png"]);
    // 多字段模型没有 urls 字段，多一个未知键会让整单被拒。
    expect(body.urls).toBeUndefined();
    expect(dropped).toBe(1);
  });

  it("全部都没有字段时不报丢弃，仍走旧的 urls 形状", () => {
    let dropped = 0;
    const body = buildInput(request([input("a"), input("b")]), urls, (count) => {
      dropped = count;
    });
    expect(body.urls).toEqual(urls);
    expect(dropped).toBe(0);
  });

  it("视频模型也按字段写：ppserver 的视频模板用 3_image / 1x_image", () => {
    const videoReq = { ...request([input("a", "3_image"), input("b", "1x_image")]), modelType: "video" as const };
    const body = buildInput(videoReq, ["https://cdn.example/a.png", "https://cdn.example/b.png"]);
    expect(body).toMatchObject({
      "3_image": [{ url: "https://cdn.example/a.png", role: "reference_image" }],
      "1x_image": [{ url: "https://cdn.example/b.png", role: "reference_image" }]
    });
    // 不能落回按角色猜出来的 urls。
    expect(body.urls).toBeUndefined();
  });

  it("视频模型没有 field 时仍按角色猜字段（ark 的既有约定）", () => {
    const videoReq = { ...request([input("a")]), modelType: "video" as const };
    const body = buildInput(videoReq, ["https://cdn.example/a.png"]);
    expect(body.urls).toEqual([{ url: "https://cdn.example/a.png", role: "reference_image" }]);
  });

  it("没有参考图时不写任何字段", () => {
    const body = buildInput(request([]), []);
    expect(body.urls).toBeUndefined();
    expect(body["3_image"]).toBeUndefined();
  });

  it("参数里的同名字段不被参考图覆盖错位：字段按输入顺序追加", () => {
    const req = request([input("a", "3_image")]);
    req.parameters = { model: "ppserver:tpl", resolution: "2K" };
    const body = buildInput(req, ["https://cdn.example/a.png"]);
    expect(body).toMatchObject({ resolution: "2K", "3_image": ["https://cdn.example/a.png"] });
  });
});
