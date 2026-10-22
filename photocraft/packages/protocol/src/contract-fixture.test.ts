/**
 * 跨语言语义 fixture 核对（change: 2026-10-21-extract-photocraft-subproject，任务 2.3 / design D2）。
 *
 * 迁移前 contracts 的交叉核对测试既读 Rust workspace 的 `project-limits.json`，又（Rust 侧）
 * `include_str!` 读宿主 TS 源码，两个方向都让测试穿透目录。现在唯一共享数据是子项目内的
 * `tests/fixtures/contract.json`：Rust 的 `tests/contract_fixture.rs` 与这里指向同一文件。
 *
 * 本测试保证：协议包常量与 fixture 一致；且 fixture 记录的历史指纹能被当前实现**逐字节复现**
 * （旧版本/旧 MIME/旧指纹兼容的固定证据）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  IMAGE_EDIT_DOCUMENT_VERSION,
  IMAGE_EDIT_LIMITS,
  IMAGE_PROJECT_CONTENT_TYPE,
  IMAGE_PROJECT_DOCUMENT_VERSION,
  IMAGE_PROJECT_LIMITS,
  PHOTOCRAFT_CAPABILITIES,
  PHOTOCRAFT_ENGINE_COMMIT,
  PHOTOCRAFT_ENGINE_VERSION,
  SUPPORTED_PHOTOCRAFT_ENGINE_VERSIONS,
  SUPPORTED_PHOTOCRAFT_FORMAT_VERSIONS,
  canonicalizeImageProjectContent,
  fnv1a64Hex,
  imageEditDefinitionHash,
  imageEditShapesHash,
  imageProjectContentHash,
  type ImageProjectContent
} from "./index.js";

type Fixture = {
  upstreamRepository: string;
  upstreamCommit: string;
  upstreamVersion: string;
  engineVersion: string;
  supportedEngineVersions: string[];
  formatVersion: number;
  supportedFormatVersions: number[];
  contentType: string;
  documentVersions: { legacy: string; project: string };
  capabilities: string[];
  contentHashes: {
    fnv1a64ProbeText: string;
    fnv1a64UnicodeFloatProbe: string;
    projectContentCanonical: string;
    projectContentHash: string;
    legacyShapesHash: string;
    legacyDefinitionHash: string;
  };
};

const FIXTURE: Fixture = JSON.parse(
  readFileSync(new URL("../../../tests/fixtures/contract.json", import.meta.url), "utf8")
);

/** 历史基线：与 fixture 的 `legacyShapesHash` / `legacyDefinitionHash` 对应。 */
const LEGACY_DOCUMENT = {
  version: IMAGE_EDIT_DOCUMENT_VERSION,
  baseAssetId: "asset-1",
  sourceWidth: 800,
  sourceHeight: 600,
  shapes: [
    {
      id: "s1",
      tool: "pen" as const,
      color: "#ff8a1f",
      widthInSourcePixels: 4,
      // 故意带浮点噪声：归一化后必须与迁移前同值。
      points: [
        { x: 0.1, y: 0.2 },
        { x: 0.30004, y: 0.40009 }
      ]
    }
  ]
};

/** 历史 fixture 的规范内容（与 Rust `identity.rs` 同一输入）。 */
const FIXTURE_CONTENT: ImageProjectContent = {
  canvasWidth: 800,
  canvasHeight: 600,
  layers: [
    {
      id: "background",
      name: "背景",
      kind: "pixel",
      visible: true,
      opacity: 1,
      blend: "normal",
      transform: {
        translateX: 0,
        translateY: 0,
        scale: 1,
        rotationDegrees: 0,
        flipHorizontal: false,
        flipVertical: false
      },
      mask: null,
      pixel: { sourceAssetId: "asset-base", contentHash: "0123456789abcdef" },
      text: null,
      adjustment: null
    }
  ]
};

describe("跨语言 fixture 与协议常量一致", () => {
  it("引擎来源、版本与格式版本", () => {
    expect(FIXTURE.upstreamRepository).toBe("storytold/photocraft");
    expect(FIXTURE.upstreamCommit).toBe(PHOTOCRAFT_ENGINE_COMMIT);
    expect(FIXTURE.engineVersion).toBe(PHOTOCRAFT_ENGINE_VERSION);
    expect(FIXTURE.supportedEngineVersions).toEqual([...SUPPORTED_PHOTOCRAFT_ENGINE_VERSIONS]);
    expect(FIXTURE.supportedFormatVersions).toEqual([...SUPPORTED_PHOTOCRAFT_FORMAT_VERSIONS]);
    expect(FIXTURE.formatVersion).toBe(1);
  });

  it("媒体类型与文档版本", () => {
    expect(FIXTURE.contentType).toBe(IMAGE_PROJECT_CONTENT_TYPE);
    expect(FIXTURE.documentVersions.legacy).toBe(IMAGE_EDIT_DOCUMENT_VERSION);
    expect(FIXTURE.documentVersions.project).toBe(IMAGE_PROJECT_DOCUMENT_VERSION);
  });

  it("已开放能力清单", () => {
    expect(FIXTURE.capabilities).toEqual([...PHOTOCRAFT_CAPABILITIES]);
  });

  it("上限清单只由 rust/project-limits.json 一份拥有", () => {
    const limits = JSON.parse(
      readFileSync(new URL("../../../rust/project-limits.json", import.meta.url), "utf8")
    ) as Record<string, unknown>;
    for (const [key, value] of Object.entries(IMAGE_PROJECT_LIMITS)) {
      expect(limits[key], `project-limits.json 的 ${key}`).toBe(value);
    }
  });
});

describe("历史内容指纹逐字节兼容", () => {
  it("FNV-1a 64 对 Unicode 与浮点文本复现基线", () => {
    expect(FIXTURE.contentHashes.fnv1a64ProbeText).toBe("中文\u0000float1.0000001\u0000a");
    expect(fnv1a64Hex(FIXTURE.contentHashes.fnv1a64ProbeText)).toBe(
      FIXTURE.contentHashes.fnv1a64UnicodeFloatProbe
    );
  });

  it("工程规范内容与指纹复现基线", () => {
    expect(canonicalizeImageProjectContent(FIXTURE_CONTENT)).toBe(
      FIXTURE.contentHashes.projectContentCanonical
    );
    expect(imageProjectContentHash(FIXTURE_CONTENT)).toBe(FIXTURE.contentHashes.projectContentHash);
  });

  it("旧标注 shape 与定义指纹复现基线", () => {
    expect(imageEditShapesHash({ shapes: LEGACY_DOCUMENT.shapes })).toBe(
      FIXTURE.contentHashes.legacyShapesHash
    );
    expect(imageEditDefinitionHash(LEGACY_DOCUMENT)).toBe(FIXTURE.contentHashes.legacyDefinitionHash);
  });

  it("旧标注上限未被迁移改写", () => {
    expect(IMAGE_EDIT_LIMITS.maxShapes).toBe(128);
    expect(IMAGE_EDIT_LIMITS.maxPointsPerShape).toBe(2048);
    expect(IMAGE_EDIT_LIMITS.maxWidthInSourcePixels).toBe(64);
    expect(IMAGE_EDIT_LIMITS.maxSourceDimension).toBe(8192);
  });
});
