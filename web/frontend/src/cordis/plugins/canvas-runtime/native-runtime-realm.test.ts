// @vitest-environment jsdom
/**
 * native realm 连通性：`#bevy-canvas` 切到新宿主后仍应视为连通。
 *
 * 缺陷（本用例锁定）：`connected()` 曾把父节点与创建 realm 时的快照比较，而该 canvas 是
 * 跨 page scope 复用的单例（见 `bevy-canvas-element.ts`）。切换画布后 `parentElement` 必然
 * 改变 → 永久 `false` → `bevy-runtime` 每秒 `supervisor.fail("surface-detached")`；该原因
 * 不计入失败次数，于是 Bevy App 无限重建（真机观测约 2.5 次/秒）。
 */
import { afterEach, expect, it, vi } from "vitest";
import { mountBevyCanvas, resetBevyCanvasElement, unmountBevyCanvas } from "../canvas-shell/bevy-canvas-element.js";
import { createNativeRuntimeRealm } from "./native-runtime-realm.js";

afterEach(() => { resetBevyCanvasElement(); document.body.innerHTML = ""; vi.useRealTimers(); });

function nativeTarget() {
  const target = Object.create(globalThis) as typeof globalThis & {
    __WOOHAA_NATIVE__: { protocol: string; token: string };
  };
  target.__WOOHAA_NATIVE__ = { protocol: "woohaa-native-v1", token: "t" };
  // 最小 XHR 替身：realm 创建期只做同步探测，不校验响应内容。
  (target as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = class {
    status = 200;
    responseText = JSON.stringify({ ok: true, value: null });
    open() {}
    setRequestHeader() {}
    send() {}
  };
  return target as typeof globalThis;
}

it("native texture uploads send the original byte view, including its slice boundaries", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  mountBevyCanvas(host);
  const target = nativeTarget();
  const sent: unknown[] = [];
  (target as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = class {
    status = 200;
    responseText = JSON.stringify({ ok: true, value: null });
    open() {}
    setRequestHeader() {}
    overrideMimeType() {}
    send(body: unknown) { sent.push(body); }
  };
  const realm = await createNativeRuntimeRealm(target, vi.fn());
  const backing = new Uint8Array([99, 1, 2, 3, 4, 88]);
  const pixels = backing.subarray(1, 5);
  try {
    realm.module.set_texture("image", 1, 1, pixels, "asset");
    realm.module.set_model_media_texture!("plane", 1, 1, pixels);
    for (const body of sent.slice(-2)) {
      expect(body).toBe(pixels);
      expect(body).toBeInstanceOf(Uint8Array);
      expect(Array.from(body as Uint8Array)).toEqual([1, 2, 3, 4]);
    }
  } finally {
    realm.dispose();
  }
});

it.runIf(typeof SharedArrayBuffer !== "undefined")("shared pixel views are copied to an XHR-compatible snapshot", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  mountBevyCanvas(host);
  const target = nativeTarget();
  let sent: unknown;
  (target as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = class {
    status = 200;
    responseText = JSON.stringify({ ok: true, value: null });
    open() {}
    setRequestHeader() {}
    overrideMimeType() {}
    send(body: unknown) { sent = body; }
  };
  const realm = await createNativeRuntimeRealm(target, vi.fn());
  const backing = new Uint8Array(new SharedArrayBuffer(6));
  backing.set([99, 1, 2, 3, 4, 88]);
  try {
    realm.module.set_texture("image", 1, 1, backing.subarray(1, 5), "asset");
    expect(sent).toBeInstanceOf(Uint8Array);
    expect((sent as Uint8Array).buffer).toBeInstanceOf(ArrayBuffer);
    backing.fill(0);
    expect(Array.from(sent as Uint8Array)).toEqual([1, 2, 3, 4]);
  } finally {
    realm.dispose();
  }
});

it("画布切到新宿主后仍连通", async () => {
  const hostA = document.createElement("div");
  const hostB = document.createElement("div");
  document.body.append(hostA, hostB);

  mountBevyCanvas(hostA);
  const realm = await createNativeRuntimeRealm(nativeTarget(), vi.fn());
  expect(realm.connected()).toBe(true);

  // 切画布：旧 scope 卸载，新 scope 复用同一单例元素挂到新宿主。
  unmountBevyCanvas(hostA);
  mountBevyCanvas(hostB);
  expect(document.querySelector("canvas#bevy-canvas")?.parentElement).toBe(hostB);
  expect(realm.connected()).toBe(true);

  realm.dispose();
});

it("reveal 标记宿主 curtain 已解除，dispose 清理", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  mountBevyCanvas(host);
  const realm = await createNativeRuntimeRealm(nativeTarget(), vi.fn());
  expect(host.dataset.canvasPresented).toBeUndefined();
  realm.reveal();
  expect(host.dataset.canvasPresented).toBe("true");
  realm.dispose();
  expect(host.dataset.canvasPresented).toBeUndefined();
});

it("画布真正离开文档后报告断开", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  mountBevyCanvas(host);
  const realm = await createNativeRuntimeRealm(nativeTarget(), vi.fn());
  expect(realm.connected()).toBe(true);

  unmountBevyCanvas(host);
  expect(document.querySelector("canvas#bevy-canvas")).toBeNull();
  expect(realm.connected()).toBe(false);

  realm.dispose();
});

it("dispose 后不再连通", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  mountBevyCanvas(host);
  const realm = await createNativeRuntimeRealm(nativeTarget(), vi.fn());
  realm.dispose();
  expect(realm.connected()).toBe(false);
});

/**
 * 剪贴板语义前提（change: fix-desktop-native-menu-clipboard-shortcuts）。
 *
 * 浏览器 realm 由 iframe 转发在 pointerdown 上聚焦输入 canvas；原生 realm 没有 iframe。
 * 若画布点击后 `activeElement` 仍是 body，macOS 原生 Edit 菜单会吃掉 Cmd+C，WebKit 也不派发
 * DOM `copy`，复制节点完全失效。这里锁定「原生 realm 让画布可聚焦并在按下时取得焦点」。
 */
it("原生画布可聚焦，指针按下即取得焦点", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const canvas = mountBevyCanvas(host);
  const realm = await createNativeRuntimeRealm(nativeTarget(), vi.fn());

  expect(canvas.tabIndex).toBe(0);
  canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  expect(document.activeElement).toBe(canvas);

  realm.dispose();
  // 原有的 tabindex 属性状态必须还原：canvas 是跨 scope 复用的单例，不能留下本 realm 的副作用。
  expect(canvas.hasAttribute("tabindex")).toBe(false);
});

it("已有 tabindex 的宿主元素不被 dispose 改写", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const canvas = mountBevyCanvas(host);
  canvas.tabIndex = -1;
  const realm = await createNativeRuntimeRealm(nativeTarget(), vi.fn());
  realm.dispose();
  expect(canvas.getAttribute("tabindex")).toBe("-1");
});

it("native gizmo RPC preserves transient tools, feedback, constraints and identity", async () => {
  const host=document.createElement("div");document.body.append(host);mountBevyCanvas(host);
  const target=nativeTarget();
  const editor={version:"woohaa-model-editor-v2",nodeId:"film",itemId:"item",toolMode:"object",objectTool:"yaw",feedback:{epoch:9,active:"yaw-ring"}};
  const response={available:true,generation:4,epoch:9,layoutId:"accepted",handle:"yaw-ring",yawConstraint:{mode:"tangent",direction:[1,0],radiansPerPixel:0.02}};
  let received:unknown;
  (target as unknown as {XMLHttpRequest:unknown}).XMLHttpRequest=class {
    status=200;responseText=JSON.stringify({ok:true,value:null});
    open(){} setRequestHeader(){}
    send(body:string|null){
      if(!body)return;
      const request=JSON.parse(body);
      if(request.method==="query_gizmo_hit") {received=JSON.parse(request.args[0]);this.responseText=JSON.stringify({ok:true,value:JSON.stringify(response)});}
    }
  };
  const realm=await createNativeRuntimeRealm(target,vi.fn());
  const input={kind:"object",generation:4,editor,x:100,y:200};
  expect(JSON.parse(realm.module.query_gizmo_hit!(JSON.stringify(input)))).toEqual(response);
  expect(received).toEqual(input);realm.dispose();
});
