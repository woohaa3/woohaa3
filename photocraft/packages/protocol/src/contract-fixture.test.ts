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
  PHOTOCRAFT_DELIVERED_STAGES,
  PHOTOCRAFT_ENGINE_COMMIT,
  PHOTOCRAFT_ENGINE_VERSION,
  PHOTOCRAFT_NON_GOALS,
  PHOTOCRAFT_STAGES,
  PHOTOCRAFT_STAGE_CAPABILITIES,
  SUPPORTED_PHOTOCRAFT_ENGINE_VERSIONS,
  SUPPORTED_PHOTOCRAFT_FORMAT_VERSIONS,
  canonicalizeImageProjectContent,
  fnv1a64Hex,
  imageEditDefinitionHash,
  imageEditShapesHash,
  imageProjectContentHash,
  isPhotocraftCapabilityEnabled,
  photocraftFeatureDisabledReason,
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
  capabilityStages: string[];
  nonGoals: string[];
  capabilities: string[];
  contentHashes: {
    fnv1a64ProbeText: string;
    fnv1a64UnicodeFloatProbe: string;
    projectContentCanonical: string;
    projectContentHash: string;
    legacyShapesHash: string;
    legacyDefinitionHash: string;
    typographyContent: ImageProjectContent;
    typographyCanonical: string;
    typographyHash: string;
    typographyRunsContent: ImageProjectContent;
    typographyRunsCanonical: string;
    typographyRunsHash: string;
    vectorPathCanonical: string;
    vectorPathHash: string;
    shapeAppearanceCanonical: string;
    shapeAppearanceHash: string;
    maskDensityCanonical: string;
    maskDensityHash: string;
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

  it("阶段清单与非目标清单前后端一致", () => {
    expect(FIXTURE.capabilityStages).toEqual([...PHOTOCRAFT_STAGES]);
    expect(FIXTURE.nonGoals).toEqual([...PHOTOCRAFT_NON_GOALS]);
    // 已交付阶段的能力必须全部出现在能力清单中，且没有阶段被漏算。
    const delivered = PHOTOCRAFT_DELIVERED_STAGES.flatMap((stage) => [...PHOTOCRAFT_STAGE_CAPABILITIES[stage]]);
    expect([...PHOTOCRAFT_CAPABILITIES]).toEqual(delivered);
    for (const id of FIXTURE.capabilities) {
      expect(photocraftFeatureDisabledReason(id)).toBeNull();
    }
    for (const id of FIXTURE.nonGoals) {
      expect(isPhotocraftCapabilityEnabled(id)).toBe(false);
      expect(photocraftFeatureDisabledReason(id)).toContain("不在本次范围");
    }
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

  it("动画内容进入共享规范文本，且旧内容文本逐字节不变", () => {
    const plain = canonicalizeImageProjectContent(FIXTURE_CONTENT);
    expect(plain).not.toContain("animation:");

    const animated: ImageProjectContent = {
      ...FIXTURE_CONTENT,
      animation: {
        timeline: { fps: 24, duration: 3 },
        layers: [
          {
            name: "视频",
            video: {
              fps: 30,
              showAltered: true,
              frames: [{ contentHash: "0123456789abcdef", width: 8, height: 8, format: "RGBA8" }]
            }
          }
        ]
      }
    };
    // 与 Rust `identity::tests::animation_summary_joins_the_shared_canonical_form` 同一期望文本。
    expect(canonicalizeImageProjectContent(animated)).toBe(
      `${plain}\nanimation:24,3:47:[42:2:视频@30,1,29:[0123456789abcdef,8,8,RGBA8;]]`
    );
    expect(imageProjectContentHash(animated)).not.toBe(imageProjectContentHash(FIXTURE_CONTENT));

    // 非法动画内容必须让指纹不可判定，不能静默忽略后当成「没变化」。
    const broken = { ...animated, animation: { timeline: { fps: Number.NaN, duration: 3 }, layers: [] } };
    expect(canonicalizeImageProjectContent(broken)).toBeNull();
    expect(imageProjectContentHash(broken)).toBeNull();
  });

  /**
   * 排版内容的跨语言基线（change: 2026-10-22-add-photocraft-typography-workflows，任务 3.2）。
   *
   * 这一条覆盖的正是本 change 新增的内容面：逐字符 run、段落选项、OpenType、Warp、抗锯齿、
   * 样式表引用。Rust 侧同名断言在 `rust/crates/editor-core/tests/contract_fixture.rs`，
   * 两边读同一份 fixture，任何一侧少写一个字段都会立刻失败。
   */
  it("排版内容规范文本与指纹复现跨语言基线", () => {
    expect(canonicalizeImageProjectContent(FIXTURE.contentHashes.typographyContent)).toBe(
      FIXTURE.contentHashes.typographyCanonical
    );
    expect(imageProjectContentHash(FIXTURE.contentHashes.typographyContent)).toBe(
      FIXTURE.contentHashes.typographyHash
    );
  });

  /**
   * 逐 run 与文档级样式表摘要的跨语言基线（同 change 任务 3.2）。
   *
   * 输入里的 `charRuns` 故意把 `tracking` 写在 `leading` 之前：两侧都必须按字段名排序后再拼接，
   * 否则「同一排版、不同写入顺序」会得到两个指纹。`textStyles` 覆盖「改样式表本身」——
   * 引用它的文字层看起来毫无变化，只有文档级摘要能把它判脏。
   */
  it("逐 run 与样式表摘要复现跨语言基线", () => {
    expect(canonicalizeImageProjectContent(FIXTURE.contentHashes.typographyRunsContent)).toBe(
      FIXTURE.contentHashes.typographyRunsCanonical
    );
    expect(imageProjectContentHash(FIXTURE.contentHashes.typographyRunsContent)).toBe(
      FIXTURE.contentHashes.typographyRunsHash
    );
  });

  it("矢量路径内容身份与 Rust 逐字节一致", () => {
    // 已存命名路径 / 工作路径 / 裁切路径是持久字段：两端必须得到同一规范文本与指纹。
    expect(canonicalizeImageProjectContent(FIXTURE_CONTENT)).toBe(FIXTURE.contentHashes.projectContentCanonical);
    const withPaths: ImageProjectContent = {
      ...FIXTURE_CONTENT,
      paths: [
        { name: "中文", contentHash: "1111111111111111" },
        { name: "A", contentHash: "2222222222222222" }
      ],
      workPath: { contentHash: "3333333333333333" },
      clippingPath: { name: "A", flatness: 2.5 }
    };
    expect(canonicalizeImageProjectContent(withPaths)).toBe(FIXTURE.contentHashes.vectorPathCanonical);
    expect(imageProjectContentHash(withPaths)).toBe(FIXTURE.contentHashes.vectorPathHash);
    // 空值不改变旧指纹（旧工程兼容）。
    expect(canonicalizeImageProjectContent({ ...FIXTURE_CONTENT, paths: [], workPath: null, clippingPath: null }))
      .toBe(FIXTURE.contentHashes.projectContentCanonical);
  });

  it("形状外观与矢量蒙版密度/羽化与 Rust 逐字节一致", () => {
    // 几何摘要相同、只改填充/描边/规范参数：这也是持久内容，必须改变指纹。
    const background = FIXTURE_CONTENT.layers[0]!;
    const withShape: ImageProjectContent = {
      ...FIXTURE_CONTENT,
      layers: [
        background,
        {
          ...background,
          id: "layer-2",
          name: "形状",
          kind: "shape",
          pixel: null,
          shape: { contentHash: "4444444444444444", appearanceHash: "5555555555555555" }
        }
      ]
    };
    expect(canonicalizeImageProjectContent(withShape)).toBe(
      FIXTURE.contentHashes.shapeAppearanceCanonical
    );
    expect(imageProjectContentHash(withShape)).toBe(FIXTURE.contentHashes.shapeAppearanceHash);

    // 矢量蒙版密度/羽化同样是持久字段。
    const withMask: ImageProjectContent = {
      ...FIXTURE_CONTENT,
      layers: [
        {
          ...background,
          vectorMask: { enabled: true, contentHash: "6666666666666666", density: 0.4, feather: 6 }
        }
      ]
    };
    expect(canonicalizeImageProjectContent(withMask)).toBe(
      FIXTURE.contentHashes.maskDensityCanonical
    );
    expect(imageProjectContentHash(withMask)).toBe(FIXTURE.contentHashes.maskDensityHash);
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
