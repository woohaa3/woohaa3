/**
 * Mention codec bridge 与 token 草稿恢复
 * （change: add-reference-inputs-and-mentions，任务 4.1 / 4.5）。
 */
import { describe, expect, it } from "vitest";
import { serializeWoohaa3CanvasMention, type Woohaa3CanvasMention } from "@woohaa3/contracts";
import { editorNodesToTokenString, tokenStringToEditorNodes } from "./codec-bridge.js";
import { nodeDraftStore } from "../drafts.js";

const IMAGE: Woohaa3CanvasMention = { type: "input_image", slotId: "slot-a", label: "图片 1" };
const TEXT: Woohaa3CanvasMention = { type: "input_text", slotId: "slot-t", label: "文本 1" };

describe("tokenStringToEditorNodes", () => {
  it("切分文本与 mention", () => {
    const token = serializeWoohaa3CanvasMention(IMAGE)!;
    const nodes = tokenStringToEditorNodes(`看 ${token} 生成`);
    expect(nodes.map((node) => node.kind)).toEqual(["text", "mention", "text"]);
    expect(nodes[1]).toMatchObject({ kind: "mention", mention: IMAGE });
  });

  it("空串返回空数组", () => {
    expect(tokenStringToEditorNodes("")).toEqual([]);
  });
});

describe("editorNodesToTokenString", () => {
  it("round-trip 保持 token", () => {
    const token = serializeWoohaa3CanvasMention(IMAGE)!;
    const nodes = tokenStringToEditorNodes(`x ${token} y`);
    expect(editorNodesToTokenString(nodes)).toBe(`x ${token} y`);
  });

  it("可自定义序列化（失效降级）", () => {
    const nodes = tokenStringToEditorNodes(serializeWoohaa3CanvasMention(TEXT)!);
    const downgraded = editorNodesToTokenString(nodes, (mention) => `@${mention.label}`);
    expect(downgraded).toBe("@文本 1");
  });
});

describe("mention 草稿按 nodeId 隔离（任务 4.5）", () => {
  it("token string 存入草稿并按节点隔离", () => {
    const token = serializeWoohaa3CanvasMention(IMAGE)!;
    nodeDraftStore.patch("node-a", { prompt: `A ${token}` });
    nodeDraftStore.patch("node-b", { prompt: "B 纯文本" });
    expect(nodeDraftStore.get("node-a")?.prompt).toContain(token);
    expect(nodeDraftStore.get("node-b")?.prompt).toBe("B 纯文本");
    // 清理
    nodeDraftStore.clear("node-a");
    nodeDraftStore.clear("node-b");
  });
});
