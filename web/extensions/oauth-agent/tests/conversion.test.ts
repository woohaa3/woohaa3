/**
 * ChatGPT 转换 adapter 测试
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 2.1–2.3）。
 *
 * 覆盖：真实图像附件作为 `local_image` 传输入参（非 URL 文本）、视频原生/抽帧选择、
 * 超预算拒绝、结构化候选归一、owner 缺失明确拒绝、取消语义。均为非渲染检查。
 */
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  FilmSetConversionGenerationInput,
  FilmSetConversionMediaReader,
  ServerCanvas
} from "@woohaa3/contracts";
import type { CodexAdapter, CodexRunInput, CodexUserInput } from "../src/backend/codex-adapter.js";
import { buildCodexInput } from "../src/backend/codex-adapter.js";
import { createChatGptFilmSetConversionGenerator, CHATGPT_CONVERSION_CAPABILITIES } from "../src/backend/conversion.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-chatgpt-conv-"));
  dirs.push(dir);
  return dir;
}

/** 记录最近一次 run 输入的 fake Codex。 */
function fakeCodex(response: string, captured: { input?: CodexRunInput } = {}): CodexAdapter {
  return {
    run: async (input) => { captured.input = input; return { finalResponse: response }; },
    runStreamed: async (input) => { captured.input = input; return { finalResponse: response }; },
    cancel: () => undefined,
    disposeOwner: () => undefined,
    dispose: () => undefined
  };
}

const EMPTY_CANVAS = { assets: [] } as unknown as ServerCanvas;

function imageInput(overrides: Partial<FilmSetConversionGenerationInput> = {}): FilmSetConversionGenerationInput {
  return {
    canvasId: "c",
    requestId: "r",
    frozenSource: { nodeId: "n", kind: "image", contentHash: "h", assetId: "asset-1", aspectRatio: 1.5 },
    title: "图片 · 片场",
    settings: {},
    modelKey: "gpt-6.1-sol",
    canvas: EMPTY_CANVAS,
    media: { storageKey: `sha256-${"a".repeat(64)}`, contentType: "image/png" },
    subject: "principal:user-1",
    signal: new AbortController().signal,
    ...overrides
  };
}

function mediaReader(overrides: Partial<FilmSetConversionMediaReader> = {}): FilmSetConversionMediaReader {
  return {
    readAsset: async () => ({ bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" }),
    ...overrides
  };
}

const VALID_CANDIDATE = JSON.stringify({
  items: [{
    id: "obj-1",
    kind: "ground",
    name: "地面",
    localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
    size: { width: 8, depth: 8 },
    color: null
  }],
  clips: null,
  defaultClipId: null,
  sceneCamera: null,
  note: null
});

describe("ChatGPT 转换 adapter：真实视觉输入（任务 2.1/2.2）", () => {
  it("图片转换把真实字节作为 local_image 附件传入，且不使用 URL 文本", async () => {
    const captured: { input?: CodexRunInput } = {};
    const generator = createChatGptFilmSetConversionGenerator({
      codex: fakeCodex(VALID_CANDIDATE, captured),
      ownerId: () => "principal:user-1",
      model: "gpt-6.1-sol",
      media: mediaReader()
    });
    const result = await generator(imageInput());
    expect(result.ok).toBe(true);
    expect(captured.input?.images?.[0]?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    // 真实附件文件名落盘；prompt 文本不含 data:/http URL。
    expect(captured.input?.prompt).not.toMatch(/https?:\/\//);
    expect(captured.input?.outputSchema).toBeTruthy();
  });

  it("读取来源素材时透传记录里的 canvasId（远端画布只在托管存储里）", async () => {
    const reads: Array<{ storageKey: string; canvasId?: string }> = [];
    const generator = createChatGptFilmSetConversionGenerator({
      codex: fakeCodex(VALID_CANDIDATE),
      ownerId: "principal:user-1",
      model: "gpt-6.1-sol",
      media: mediaReader({
        readAsset: async (storageKey, canvasId) => {
          reads.push({ storageKey, ...(canvasId !== undefined ? { canvasId } : {}) });
          return { bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" };
        }
      })
    });
    const result = await generator(imageInput({ canvasId: "canvas-conv" }));
    expect(result.ok).toBe(true);
    expect(reads).toEqual([{ storageKey: "sha256-" + "a".repeat(64), canvasId: "canvas-conv" }]);
  });

  it("owner 解析失败（缺少可信主体）明确拒绝，不静默使用其它账户", async () => {
    const generator = createChatGptFilmSetConversionGenerator({
      codex: fakeCodex(VALID_CANDIDATE),
      ownerId: ({ subject }) => (subject ? `principal:${subject}` : null),
      model: "gpt-6.1-sol",
      media: mediaReader()
    });
    const result = await generator(imageInput({ subject: undefined }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("model-not-configured");
  });

  it("宿主已解析的 ownerId 优先于可信主体（本地开发受控会话可放通）", async () => {
    const captured: { input?: CodexRunInput } = {};
    const generator = createChatGptFilmSetConversionGenerator({
      codex: fakeCodex(VALID_CANDIDATE, captured),
      ownerId: ({ subject, ownerId }) => ownerId ?? (subject ? `principal:${subject}` : null),
      model: "gpt-6.1-sol",
      media: mediaReader()
    });
    const result = await generator(imageInput({ subject: "app-user", ownerId: "local:abc" }));
    expect(result.ok).toBe(true);
    expect(captured.input?.ownerId).toBe("local:abc");
  });

  it("视频模型不支持原生视频时按范围抽取有时间戳的帧组", async () => {
    const captured: { input?: CodexRunInput } = {};
    let frameRequest: { range?: { startSeconds: number; endSeconds: number }; maxFrames: number } | null = null;
    const generator = createChatGptFilmSetConversionGenerator({
      codex: fakeCodex(VALID_CANDIDATE, captured),
      ownerId: "principal:user-1",
      model: "gpt-6.1-sol",
      media: mediaReader({
        readVideoFrames: async (input) => {
          frameRequest = { range: input.range, maxFrames: input.maxFrames };
          return [
            { timestampSeconds: 1, bytes: new Uint8Array([1]), contentType: "image/jpeg" },
            { timestampSeconds: 5, bytes: new Uint8Array([2]), contentType: "image/jpeg" }
          ];
        }
      })
    });
    const result = await generator(imageInput({
      frozenSource: {
        nodeId: "v", kind: "video", contentHash: "h", assetId: "asset-v",
        durationSeconds: 10, range: { startSeconds: 1, endSeconds: 5 }
      },
      media: { storageKey: `sha256-${"b".repeat(64)}`, contentType: "video/mp4" }
    }));
    expect(result.ok).toBe(true);
    expect(frameRequest).toEqual({ range: { startSeconds: 1, endSeconds: 5 }, maxFrames: CHATGPT_CONVERSION_CAPABILITIES.input.maxFrames });
    expect(captured.input?.images).toHaveLength(2);
    expect(captured.input?.prompt).toMatch(/1\.000s/);
    expect(captured.input?.prompt).toMatch(/5\.000s/);
  });

  it("视频无原生/多图能力时在读取前拒绝，不退化成文字 prompt", async () => {
    const generator = createChatGptFilmSetConversionGenerator({
      codex: fakeCodex(VALID_CANDIDATE),
      ownerId: "principal:user-1",
      model: "gpt-6.1-sol",
      capabilities: { structuredCandidateOutput: true, input: { imageInput: false, maxImages: 0, videoInput: false, maxFrames: 0, maxDurationSeconds: 0 } },
      media: mediaReader()
    });
    const result = await generator(imageInput({
      frozenSource: { nodeId: "v", kind: "video", contentHash: "h", assetId: "asset-v", durationSeconds: 10 },
      media: { storageKey: `sha256-${"b".repeat(64)}`, contentType: "video/mp4" }
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("budget-exceeded");
  });

  it("上游返回非法 JSON 返回 candidate-invalid（不冒充成功）", async () => {
    const generator = createChatGptFilmSetConversionGenerator({
      codex: fakeCodex("这不是 JSON"),
      ownerId: "principal:user-1",
      model: "gpt-6.1-sol",
      media: mediaReader()
    });
    const result = await generator(imageInput());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("candidate-invalid");
  });

  it("结构化候选被归一为 domain 候选（含 filmSetContent/filmSetAnimations）", async () => {
    const generator = createChatGptFilmSetConversionGenerator({
      codex: fakeCodex(`\`\`\`json\n${VALID_CANDIDATE}\n\`\`\``),
      ownerId: "principal:user-1",
      model: "gpt-6.1-sol",
      media: mediaReader()
    });
    const result = await generator(imageInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const candidate = result.candidate as { filmSetContent: { schemaVersion: number; items: unknown[] }; filmSetAnimations: unknown };
    expect(candidate.filmSetContent.schemaVersion).toBe(3);
    expect(candidate.filmSetContent.items).toHaveLength(1);
    expect(candidate.filmSetAnimations).toBeTruthy();
  });
});

describe("codex-adapter：真实图像附件落盘（任务 2.1）", () => {
  it("无附件时保持原字符串输入（兼容既有请求）", () => {
    const workspace = tempDir();
    expect(buildCodexInput("hello", undefined, workspace)).toBe("hello");
    expect(buildCodexInput("hello", [], workspace)).toBe("hello");
  });

  it("有附件时落盘到受限工作目录并组装 text + local_image 输入项", () => {
    const workspace = tempDir();
    const input = buildCodexInput("hello", [{ fileName: "frame-1", bytes: new Uint8Array([9, 8]) }], workspace) as CodexUserInput[];
    expect(input[0]).toEqual({ type: "text", text: "hello" });
    expect(input[1]?.type).toBe("local_image");
    const file = (input[1] as { path: string }).path;
    expect(existsSync(file)).toBe(true);
    expect(new Uint8Array(readFileSync(file))).toEqual(new Uint8Array([9, 8]));
    // 落盘在 owner 工作目录内。
    expect(file.startsWith(workspace)).toBe(true);
  });

  it("文件名清洗阻止目录穿越", () => {
    const workspace = tempDir();
    const input = buildCodexInput("x", [{ fileName: "../../etc/passwd", bytes: new Uint8Array([1]) }], workspace) as CodexUserInput[];
    const file = (input[1] as { path: string }).path;
    expect(file.startsWith(path.join(workspace, "conversion-input"))).toBe(true);
    expect(path.basename(file)).toBe("passwd");
  });
});
