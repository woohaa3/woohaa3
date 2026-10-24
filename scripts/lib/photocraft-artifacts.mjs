/**
 * PhotoCraft 构建产物新鲜度预检
 * （2026-10-24 录制阻塞项：陈旧产物只在运行时以误导性错误暴露）。
 *
 * 背景（preflight「环境修复」1–3、6）：dev 启动只检查**文件是否存在**，于是
 * - WASM 是 10-22 的旧构建、缺 `capabilityHandshakeJson` → 双击图片节点报
 *   「图像编辑内核缺少能力协商」；
 * - `packages/protocol/dist` 缺 `verifyPhotocropHandshake`（旧版）→ 握手直接失败；
 * - `packages/project-verifier/dist` 白名单没有 `PhotoFilter` → 任何带调整层的工程保存都被拒，
 *   报「首期未开放的调整类型：undefined」。
 *
 * 这些都不该等到用户点「应用到节点」才发现。这里做两层判定：
 *
 * 1. **能力标记**：产物里必须能查到该版本必须有的导出。旧产物缺符号 → 立即判过期，
 *    与 mtime 无关（新机器拷目录、时钟漂移都不会漏）。
 * 2. **时间戳**：产物的 mtime 必须不早于其源码树里最新的文件；否则判过期。
 *
 * 纯函数 + 文件系统读取，不执行构建，便于单测。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** 产物必须包含的导出标记：缺一个就说明是旧构建。 */
export const REQUIRED_MARKERS = {
  /** 内核 glue 必须导出能力握手（change: 2026-10-16，旧构建没有）。 */
  wasm: ["capabilityHandshakeJson"],
  /** 协议包必须导出握手校验。 */
  protocol: ["verifyPhotocraftHandshake"],
  /** 工程核验器必须认识照片滤镜调整层（否则带调整层的工程存不了）。 */
  verifier: ["PhotoFilter"]
};

const ARTIFACTS = [
  {
    id: "wasm",
    label: "PhotoCraft 内核 WASM",
    files: ["photocraft_editor.js", "photocraft_editor_bg.wasm"],
    /** 产物目录相对仓库根。 */
    output: "photocraft/packages/editor/dist/wasm",
    /** 判定新鲜度的源码根（相对仓库根）。 */
    sources: ["photocraft/rust/crates"],
    markerFile: "photocraft_editor.js",
    markers: REQUIRED_MARKERS.wasm,
    /** 缺失时自动构建（子项目 WASM 构建需要 Rust 工具链，但这是唯一正确来源）。 */
    autoBuild: true,
    buildHint: "pnpm photocraft:wasm"
  },
  {
    id: "protocol",
    label: "PhotoCraft 协议包",
    files: ["index.js"],
    output: "photocraft/packages/protocol/dist",
    sources: ["photocraft/packages/protocol/src"],
    markerFile: "index.js",
    markers: REQUIRED_MARKERS.protocol,
    autoBuild: true,
    buildHint: "node client/photocraft/scripts/build-package.mjs --cwd client/photocraft/packages/protocol"
  },
  {
    id: "verifier",
    label: "PhotoCraft 工程核验器",
    files: ["index.js"],
    output: "photocraft/packages/project-verifier/dist",
    sources: ["photocraft/packages/project-verifier/src"],
    markerFile: "index.js",
    markers: REQUIRED_MARKERS.verifier,
    autoBuild: true,
    buildHint: "node client/photocraft/scripts/build-package.mjs --cwd client/photocraft/packages/project-verifier --platform node"
  }
];

/** 递归取目录里最新的 mtime；目录不存在返回 null。 */
function newestMtime(dir) {
  let newest = null;
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        // 构建缓存与依赖不参与新鲜度判定。
        if (/^(node_modules|target|\.local|dist)$/.test(entry.name)) continue;
        walk(full);
        continue;
      }
      try {
        const stat = statSync(full);
        if (newest === null || stat.mtimeMs > newest) newest = stat.mtimeMs;
      } catch {
        // 读不到就不参与判定。
      }
    }
  };
  walk(dir);
  return newest;
}

/**
 * 检查一个产物。
 *
 * @returns {{ ok: true } | { ok: false, reason: string, detail: string }}
 */
export function checkArtifact(root, spec) {
  const output = join(root, spec.output);
  for (const file of spec.files) {
    try {
      if (!statSync(join(output, file)).isFile()) throw new Error("not a file");
    } catch {
      return {
        ok: false,
        reason: "missing",
        detail: `${spec.label}尚未构建（缺 ${spec.output}/${file}）`
      };
    }
  }
  // 能力标记：比 mtime 更可靠，旧产物即使时间戳更新也会被认出。
  if (spec.markerFile && spec.markers.length > 0) {
    let text = "";
    try {
      text = readFileSync(join(output, spec.markerFile), "utf8");
    } catch {
      text = "";
    }
    const missing = spec.markers.filter((marker) => !text.includes(marker));
    if (missing.length > 0) {
      return {
        ok: false,
        reason: "outdated",
        detail: `${spec.label}是旧构建，缺少 ${missing.join("、")}；请重新构建（${spec.buildHint}）`
      };
    }
  }
  // 时间戳：产物必须不早于源码。
  let outputNewest = 0;
  for (const file of spec.files) {
    try {
      const stat = statSync(join(output, file));
      if (stat.mtimeMs > outputNewest) outputNewest = stat.mtimeMs;
    } catch {
      // 上面已判定存在。
    }
  }
  let sourceNewest = null;
  for (const relativeRoot of spec.sources) {
    const newest = newestMtime(join(root, relativeRoot));
    if (newest !== null && (sourceNewest === null || newest > sourceNewest)) sourceNewest = newest;
  }
  if (sourceNewest !== null && sourceNewest > outputNewest) {
    return {
      ok: false,
      reason: "stale",
      detail: `${spec.label}比源码旧（源码 ${new Date(sourceNewest).toISOString()} > 产物 ${new Date(outputNewest).toISOString()}）；请重新构建（${spec.buildHint}）`
    };
  }
  return { ok: true };
}

/** 全部产物检查；返回可读结果数组。 */
export function checkPhotocraftArtifacts(root) {
  return ARTIFACTS.map((spec) => ({
    id: spec.id,
    label: spec.label,
    ...checkArtifact(root, spec),
    spec
  }));
}

/** 供调用方拼可读错误：把不通过的项合成一段话。 */
export function describeArtifactFailures(failures) {
  if (failures.length === 0) return "";
  const lines = failures.map((failure) => `  · ${failure.detail ?? failure.label}`);
  return [
    "PhotoCraft 构建产物过期或缺失，dev 服务继续下去会在运行时报误导性错误",
    "（例如「图像编辑内核缺少能力协商」「首期未开放的调整类型」）：",
    ...lines,
    "先重建再启动；`pnpm photocraft:setup && pnpm photocraft:wasm` 覆盖 JS 包与内核。"
  ].join("\n");
}

/** 相对路径（测试与日志用）。 */
export function relativeTo(root, path) {
  return relative(root, path).replaceAll("\\", "/");
}
