/**
 * DataTransfer 分类与去重测试（change: add-paste-import-workflows，任务 2.1/2.2）。
 */
import { describe, expect, it } from "vitest";
import {
  classifyFileList,
  classifyPasteFile,
  classifyTransferFiles,
  collectTransferFiles,
  dedupeClassifiedFiles,
  transferMentionsFiles
} from "./datatransfer.js";

type FakeFileInit = { name: string; type?: string; size?: number; lastModified?: number; body?: string };

function makeFile(init: FakeFileInit): File {
  const name = init.name;
  const type = init.type ?? "";
  const body = init.body ?? name;
  const file = new File([body], name, { type, lastModified: init.lastModified ?? 0 });
  // File 的 size 由内容决定；需要特定 size 时覆盖属性（只读属性用 defineProperty）。
  if (init.size !== undefined && init.size !== file.size) {
    Object.defineProperty(file, "size", { value: init.size });
  }
  return file;
}

function fakeTransfer(files: File[], items: File[] = []): DataTransfer {
  return {
    files: Object.assign(files, { item: (index: number) => files[index] ?? null }) as unknown as FileList,
    items: items.map((file) => ({ kind: "file", getAsFile: () => file })) as unknown as DataTransferItemList,
    types: ["Files"],
    getData: () => ""
  } as unknown as DataTransfer;
}

describe("classifyPasteFile", () => {
  it("分类图片/视频/音频/文本并按白名单拒绝其它类型", () => {
    expect(classifyPasteFile({ name: "a.png", type: "image/png", size: 10 })).toBe("image");
    expect(classifyPasteFile({ name: "a.mp4", type: "video/mp4", size: 10 })).toBe("video");
    expect(classifyPasteFile({ name: "a.mp3", type: "audio/mpeg", size: 10 })).toBe("audio");
    expect(classifyPasteFile({ name: "a.md", type: "", size: 10 })).toBe("text");
    expect(classifyPasteFile({ name: "a.bin", type: "application/octet-stream", size: 10 })).toBeNull();
  });

  it("GLB 归为 model3d（空 MIME 也可），.gltf 明确拒绝", () => {
    expect(classifyPasteFile({ name: "model.glb", type: "", size: 1024 })).toBe("model3d");
    expect(classifyPasteFile({ name: "model.glb", type: "application/octet-stream", size: 1024 })).toBe("model3d");
    expect(classifyPasteFile({ name: "model.glb", type: "model/gltf-binary", size: 1024 })).toBe("model3d");
    expect(classifyPasteFile({ name: "model.gltf", type: "model/gltf+json", size: 1024 })).toBeNull();
  });

  it("拒绝目录、零字节与无名文件", () => {
    expect(classifyPasteFile({ name: "folder", type: "", size: 0 })).toBeNull();
    expect(classifyPasteFile({ name: "empty.png", type: "image/png", size: 0 })).toBeNull();
    expect(classifyPasteFile({ name: "", type: "image/png", size: 10 })).toBeNull();
  });
});

describe("collectTransferFiles", () => {
  it("合并 files 与 file items 并去掉同一对象引用", () => {
    const a = makeFile({ name: "a.png", type: "image/png" });
    const b = makeFile({ name: "b.png", type: "image/png" });
    const transfer = fakeTransfer([a], [a, b]);
    expect(collectTransferFiles(transfer)).toEqual([a, b]);
  });
});

describe("classifyTransferFiles / dedupeClassifiedFiles", () => {
  it("同一截图在 files 与 items 各出现一次时只保留一个", async () => {
    const shot = makeFile({ name: "shot.png", type: "image/png", body: "same" });
    const transfer = fakeTransfer([shot], [shot]);
    const { files } = classifyTransferFiles(transfer);
    expect(files).toHaveLength(1);
  });

  it("metadata 相同但内容不同不会被误删（内容 hash 区分）", async () => {
    const one = makeFile({ name: "same.png", type: "image/png", size: 4, lastModified: 1, body: "aaaa" });
    const two = makeFile({ name: "same.png", type: "image/png", size: 4, lastModified: 1, body: "bbbb" });
    // metadata 初筛会先按 name/type/size/lastModified 合并：这里用同一 transfer 的两个对象引用，
    // 但强制绕过 metadata（同引用才会被 collectTransferFiles 去掉，其它保留）。
    const transfer = fakeTransfer([one, two]);
    const { files } = classifyTransferFiles(transfer);
    expect(files).toHaveLength(1); // metadata 初筛按契约合并同 metadata 表示。
    // 内容级去重对 metadata 相同内容不同的两个对象保留两者。
    const deduped = await dedupeClassifiedFiles(
      [
        { file: one, kind: "image", name: "same.png", type: "image/png", size: 4, lastModified: 1 },
        { file: two, kind: "image", name: "same.png", type: "image/png", size: 4, lastModified: 1 }
      ],
      { subtle: crypto.subtle as never }
    );
    expect(deduped).toHaveLength(2);
  });

  it("内容相同的两个对象只保留一次", async () => {
    const one = makeFile({ name: "a.png", type: "image/png", body: "dup" });
    const two = makeFile({ name: "b.png", type: "image/png", body: "dup" });
    const deduped = await dedupeClassifiedFiles(
      [
        { file: one, kind: "image", name: "a.png", type: "image/png", size: fileSize(one), lastModified: 0 },
        { file: two, kind: "image", name: "b.png", type: "image/png", size: fileSize(two), lastModified: 0 }
      ],
      { subtle: crypto.subtle as never }
    );
    expect(deduped).toHaveLength(1);
  });

  it("hash 不可用时保留候选", async () => {
    const one = makeFile({ name: "a.png", type: "image/png", body: "x" });
    const two = makeFile({ name: "b.png", type: "image/png", body: "y" });
    const deduped = await dedupeClassifiedFiles(
      [
        { file: one, kind: "image", name: "a.png", type: "image/png", size: 1, lastModified: 0 },
        { file: two, kind: "image", name: "b.png", type: "image/png", size: 1, lastModified: 0 }
      ],
      { subtle: undefined, hashSingleMaxBytes: 0 }
    );
    // hashSingleMaxBytes=0 → 两个都超大，跳过 hash → 保留两者。
    expect(deduped).toHaveLength(2);
  });

  it("拒绝不支持/零字节并报告原因", () => {
    const ok = makeFile({ name: "ok.png", type: "image/png" });
    const bad = makeFile({ name: "bad.exe", type: "application/octet-stream" });
    const empty = makeFile({ name: "empty.png", type: "image/png", size: 0 });
    const result = classifyFileList([ok, bad, empty]);
    expect(result.files).toHaveLength(1);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected.map((entry) => entry.name)).toEqual(["bad.exe", "empty.png"]);
  });
});

describe("transferMentionsFiles", () => {
  it("只有 types 含 Files 才返回 true", () => {
    expect(transferMentionsFiles({ types: ["Files"] } as unknown as DataTransfer)).toBe(true);
    expect(transferMentionsFiles({ types: ["text/plain"] } as unknown as DataTransfer)).toBe(false);
    expect(transferMentionsFiles(null)).toBe(false);
  });
});

function fileSize(file: File): number {
  return file.size;
}
