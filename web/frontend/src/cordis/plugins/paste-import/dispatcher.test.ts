/**
 * Paste 分派优先级与 adapter registry 测试
 * （change: add-paste-import-workflows，任务 1.2 / 6.1）。
 */
import { describe, expect, it } from "vitest";
import { ClipboardAdapterRegistry, validateSemanticImportPlan, type ClipboardAdapter } from "./adapter.js";
import {
  resolveDropIntent,
  resolvePasteIntent,
  transferHasFiles,
  transferMayContainSupportedFiles
} from "./dispatcher.js";
import type { CanvasCopyPayload } from "../canvas-shell/clipboard/payload.js";
import type { ClassifiedFile } from "./datatransfer.js";

const internalPayload: CanvasCopyPayload = {
  format: "infinspire-canvas-copy-v1",
  nodes: [{ id: "n1", type: "image", position: { x: 0, y: 0 } }],
  edges: [],
  incomingEdges: [],
  nodeData: {}
};

function classified(name: string, kind: ClassifiedFile["kind"] = "image"): ClassifiedFile {
  return {
    file: new File(["x"], name, { type: kind === "image" ? "image/png" : "text/plain" }),
    kind,
    name,
    type: kind === "image" ? "image/png" : "text/plain",
    size: 1,
    lastModified: 0
  };
}

describe("resolvePasteIntent 优先级", () => {
  it("内部节点载荷优先于文件", () => {
    const intent = resolvePasteIntent({
      text: "{}",
      internalPayload,
      files: [classified("a.png")],
      adapters: new ClipboardAdapterRegistry()
    });
    expect(intent.kind).toBe("internal");
  });

  it("受控 adapter 在内部载荷未命中时接管", () => {
    const adapters = new ClipboardAdapterRegistry();
    const adapter: ClipboardAdapter = {
      id: "acme",
      canHandle: (payload) => payload.text === "acme-v1",
      plan: () => ({ source: "acme", files: [new File(["x"], "a.png", { type: "image/png" })] })
    };
    adapters.register(adapter);
    const intent = resolvePasteIntent({
      text: "acme-v1",
      internalPayload: null,
      files: [],
      adapters
    });
    expect(intent.kind).toBe("adapter");
  });

  it("无 adapter 命中时走文件导入", () => {
    const intent = resolvePasteIntent({
      text: "普通文本",
      internalPayload: null,
      files: [classified("a.png")],
      adapters: new ClipboardAdapterRegistry()
    });
    expect(intent.kind).toBe("files");
  });

  it("普通文本无文件时为无操作", () => {
    const intent = resolvePasteIntent({ text: "hello", internalPayload: null, files: [], adapters: new ClipboardAdapterRegistry() });
    expect(intent.kind).toBe("none");
  });
});

describe("resolveDropIntent", () => {
  it("只有文件才产生意图", () => {
    expect(resolveDropIntent([]).kind).toBe("none");
    expect(resolveDropIntent([classified("a.png")]).kind).toBe("files");
  });
});

describe("ClipboardAdapterRegistry", () => {
  it("稳定排序、重复 ID 拒绝与 disposer", () => {
    const registry = new ClipboardAdapterRegistry();
    const a: ClipboardAdapter = { id: "b", priority: 1, canHandle: () => true, plan: () => null };
    const b: ClipboardAdapter = { id: "a", priority: 0, canHandle: () => true, plan: () => null };
    const disposeA = registry.register(a);
    registry.register(b);
    expect(registry.list().map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(() => registry.register({ ...a })).toThrow();
    disposeA();
    expect(registry.list().map((entry) => entry.id)).toEqual(["a"]);
  });

  it("拒绝携带任意 URL 的 plan", () => {
    expect(validateSemanticImportPlan({ source: "x", files: [new File(["x"], "a.png")] })).toBeNull();
    const evil = { name: "a.png", url: "https://evil.example/a.png" } as unknown as File;
    Object.assign(evil, { arrayBuffer: async () => new ArrayBuffer(0) });
    expect(validateSemanticImportPlan({ source: "x", files: [evil] })).not.toBeNull();
  });

  it("unknown/Light Flood 格式保持 no-op", () => {
    const registry = new ClipboardAdapterRegistry();
    expect(registry.resolve({ text: "light-flood-v9", internal: null, files: [] })).toBeNull();
  });
});

describe("transferHasFiles / transferMayContainSupportedFiles", () => {
  it("drop 阶段：files 可用时视为含文件", () => {
    const png = new File(["x"], "a.png", { type: "image/png" });
    const transfer = {
      files: Object.assign([png], { item: () => png }),
      items: [],
      types: ["Files"]
    } as unknown as DataTransfer;
    expect(transferHasFiles(transfer)).toBe(true);
  });

  it("dragover 阶段：files 为空、getAsFile() 为 null 时仍按 item.kind/types 视为含文件", () => {
    // 真实 dragover：items 有 kind，但 getAsFile() 返回 null，files 为空。
    const transfer = {
      files: Object.assign([], { item: () => null }),
      items: [{ kind: "file", type: "image/png", getAsFile: () => null }],
      types: ["Files"]
    } as unknown as DataTransfer;
    expect(transferHasFiles(transfer)).toBe(true);
  });

  it("非白名单 MIME 仍是「含文件」——必须阻止导航打开（spec）", () => {
    const transfer = {
      files: Object.assign([], { item: () => null }),
      items: [{ kind: "file", type: "application/octet-stream", getAsFile: () => null }],
      types: ["Files"]
    } as unknown as DataTransfer;
    // dragover 必须接受任意文件（否则浏览器会打开它）；精确拒绝在 drop 阶段。
    expect(transferHasFiles(transfer)).toBe(true);
  });

  it("空 MIME（目录/未知）在弱判定中保守视为可能", () => {
    const transfer = {
      files: Object.assign([], { item: () => null }),
      items: [{ kind: "file", type: "", getAsFile: () => null }],
      types: ["Files"]
    } as unknown as DataTransfer;
    expect(transferMayContainSupportedFiles(transfer)).toBe(true);
  });

  it("非白名单 MIME 在弱判定中为否（仅用于反馈强弱）", () => {
    const transfer = {
      files: Object.assign([], { item: () => null }),
      items: [{ kind: "file", type: "application/octet-stream", getAsFile: () => null }],
      types: ["Files"]
    } as unknown as DataTransfer;
    expect(transferMayContainSupportedFiles(transfer)).toBe(false);
    // 但依然含文件（需阻止导航）。
    expect(transferHasFiles(transfer)).toBe(true);
  });

  it("文本拖放（非文件）不算含文件", () => {
    const transfer = {
      files: Object.assign([], { item: () => null }),
      items: [{ kind: "string", type: "text/plain", getAsFile: () => null }],
      types: ["text/plain"]
    } as unknown as DataTransfer;
    expect(transferHasFiles(transfer)).toBe(false);
    expect(transferMayContainSupportedFiles(transfer)).toBe(false);
  });
});
