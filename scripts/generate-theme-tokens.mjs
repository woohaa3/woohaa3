#!/usr/bin/env node
/**
 * 主题 token 生成/校验脚本（change: unify-application-theme-tokens，任务 1.4 / design D2）。
 *
 *   node scripts/generate-theme-tokens.mjs            # 生成全部消费者
 *   node scripts/generate-theme-tokens.mjs --check     # 只校验；与磁盘不一致时 exit 1
 *
 * canonical source（唯一手工维护的默认值）：
 *   web/contracts/src/theme/app-theme.default.json  亮色默认 preset
 *   web/contracts/src/theme/app-theme.dark.json     内置暗色 preset
 *
 * 生成物（全部**入库**，CI 运行 `--check` 后有 diff 即失败）：
 *   - web/contracts/src/theme/generated-default.ts   TypeScript 默认 snapshot
 *   - web/contracts/src/theme/generated-dark.ts      TypeScript 暗色 snapshot
 *   - web/ui/src/styles/generated-theme.css 根级 `--app-*` CSS variables（含 dark 首帧规则）
 *   - bevy/src/theme_generated.rs                    Rust fallback token 常量（仅默认 preset）
 *
 * 因此新增/删除 token 必须提升 schema version 并同时更新两个消费者；任何一端手工漂移
 * 都会被 `--check` 捕获。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const check = process.argv.includes("--check");

const CANONICAL_DEFAULT = join(root, "web", "contracts", "src", "theme", "app-theme.default.json");
const CANONICAL_DARK = join(root, "web", "contracts", "src", "theme", "app-theme.dark.json");
const OUT_TS_DEFAULT = join(root, "web", "contracts", "src", "theme", "generated-default.ts");
const OUT_TS_DARK = join(root, "web", "contracts", "src", "theme", "generated-dark.ts");
const OUT_CSS = join(root, "web", "ui", "src", "styles", "generated-theme.css");
const OUT_RS = join(root, "bevy", "src", "theme_generated.rs");

const SCHEMA_VERSION = "woohaa-app-theme-v2";
const MAX_ID_LENGTH = 80;
const MAX_JSON_BYTES = 16 * 1024;
const HEX_PATTERN = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const TOKEN_GROUPS = {
  web: [
    "webBackdrop", "webSurface", "webPanel", "webElevated", "webSubtle",
    "webTextPrimary", "webTextMuted", "webTextInverse", "webBorder", "webBorderStrong",
    "webOverlay", "webShadow"
  ],
  interaction: [
    "interactionAccent", "interactionAccentHover", "interactionAccentPressed", "interactionAccentSoft",
    "interactionFocus", "interactionOnAccent", "interactionDisabled"
  ],
  status: [
    "statusSuccess", "statusSuccessSoft", "statusSuccessBackground", "statusOnSuccess",
    "statusWarning", "statusWarningSoft", "statusWarningBackground", "statusOnWarning",
    "statusDanger", "statusDangerSoft", "statusDangerBackground", "statusOnDanger",
    "statusInfo", "statusInfoSoft", "statusInfoBackground", "statusOnInfo"
  ],
  canvas: [
    "canvasNodeSurface", "canvasNodeContent", "canvasNodeBorder", "canvasNodeBorderSelected",
    "canvasNodeShadow", "canvasNodeSelectedHalo", "canvasEdgeDefault", "canvasEdgeSelected",
    "canvasEdgeDraft", "canvasEdgeLabelBackground", "canvasEdgeLabelText", "canvasPortDefault",
    "canvasPortFill", "canvasResizeHandle", "canvasResizeHandleStripe", "canvasProgressTrack",
    "canvasProgressFill", "canvasCloseIcon", "canvasBodyText"
  ],
  nodeKind: [
    "nodeTextForeground", "nodeTextTint", "nodeImageForeground", "nodeImageTint",
    "nodeModelForeground", "nodeModelTint", "nodeAudioForeground", "nodeAudioTint",
    "nodeVideoForeground", "nodeVideoTint", "nodeDefaultForeground", "nodeDefaultTint"
  ],
  gizmo: ["gizmoAxisX", "gizmoAxisY", "gizmoAxisZ"],
  grid: ["gridMinor", "gridMajor", "gridSelection", "gridGizmo"],
  mediaDialog: [
    "mediaDialogBackdrop", "mediaDialogSurface", "mediaDialogText", "mediaDialogTextMuted",
    "mediaDialogControl", "mediaDialogControlBorder"
  ]
};

const TOKEN_NAMES = Object.values(TOKEN_GROUPS).flat();

function fail(message) {
  process.stderr.write(`[theme-tokens] ${message}\n`);
  process.exit(1);
}

function kebab(name) {
  return name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function cssVar(name) {
  return `--app-${kebab(name)}`;
}

/** `#rrggbb` / `#rrggbbaa` → sRGB 分量；无 alpha 时 alpha = 255。 */
function parseHex(value) {
  const hex = value.slice(1);
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255;
  return { r, g, b, a };
}

function validatePreset(raw, sourceLabel) {
  const bytes = Buffer.byteLength(JSON.stringify(raw), "utf8");
  if (bytes > MAX_JSON_BYTES) fail(`${sourceLabel} 超过 ${MAX_JSON_BYTES} 字节`);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail(`${sourceLabel} 必须是对象`);
  if (raw.version !== SCHEMA_VERSION) fail(`${sourceLabel} version 必须是 ${SCHEMA_VERSION}`);
  if (typeof raw.id !== "string" || raw.id.length === 0 || raw.id.length > MAX_ID_LENGTH) {
    fail(`${sourceLabel} id 非法`);
  }
  if (typeof raw.tokens !== "object" || raw.tokens === null || Array.isArray(raw.tokens)) {
    fail(`${sourceLabel} tokens 必须是对象`);
  }
  const unknown = Object.keys(raw.tokens).filter((key) => !TOKEN_NAMES.includes(key));
  if (unknown.length > 0) fail(`${sourceLabel} 含未知 token：${unknown.join(", ")}`);
  for (const name of TOKEN_NAMES) {
    const value = raw.tokens[name];
    if (typeof value !== "string" || !HEX_PATTERN.test(value)) {
      fail(`${sourceLabel} token ${name} 缺失或不是规范 hex`);
    }
  }
}

function fnv1a64(text) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

function fingerprint(preset) {
  const parts = [`id=${preset.id}`, `version=${preset.version}`];
  for (const name of TOKEN_NAMES) parts.push(`${name}=${preset.tokens[name].toLowerCase()}`);
  return fnv1a64(parts.join("|"));
}

/** 生成 TypeScript preset 文件；默认与暗色使用同一结构，只有导出名/来源不同。 */
function renderTs(preset, fp, options) {
  const { exportPrefix, sourceFile, label } = options;
  const lines = [];
  lines.push("// 由 scripts/generate-theme-tokens.mjs 生成，请勿手工编辑。");
  lines.push(`// canonical source: web/contracts/src/theme/${sourceFile}`);
  lines.push(
    options.includeCssVariables
      ? 'import type { AppThemeTokenName, AppThemeTokens } from "./schema.js";'
      : 'import type { AppThemeTokens } from "./schema.js";'
  );
  lines.push("");
  lines.push(`/** ${label} preset token（规范小写 hex）。 */`);
  lines.push(`export const ${exportPrefix}_TOKENS = {`);
  for (const [group, names] of Object.entries(TOKEN_GROUPS)) {
    lines.push(`  // ${group}`);
    for (const name of names) {
      lines.push(`  ${name}: "${preset.tokens[name].toLowerCase()}",`);
    }
  }
  lines.push("} as const satisfies AppThemeTokens;");
  lines.push("");
  lines.push(`export const ${exportPrefix}_ID = ${JSON.stringify(preset.id)};`);
  lines.push(`export const ${exportPrefix}_FINGERPRINT = ${JSON.stringify(fp)};`);
  lines.push("");
  lines.push("/** " + label + " preset（生成物）；结构与 `" + sourceFile + "` 一致。 */");
  lines.push(`export const ${exportPrefix}_PRESET = {`);
  lines.push(`  id: ${exportPrefix}_ID,`);
  lines.push(`  version: ${JSON.stringify(preset.version)} as const,`);
  lines.push(`  tokens: ${exportPrefix}_TOKENS`);
  lines.push("} as const;");
  if (options.includeCssVariables) {
    lines.push("");
    lines.push("/** token 名 → 根级 `--app-*` CSS variable。 */");
    lines.push("export const APP_THEME_CSS_VARIABLES: Record<AppThemeTokenName, string> = {");
    for (const name of TOKEN_NAMES) {
      lines.push(`  ${name}: "${cssVar(name)}",`);
    }
    lines.push("};");
    lines.push("");
    lines.push("/** 规范 `--app-*` variable 集合（供迁移期 alias 与主题守卫引用）。 */");
    lines.push("export const APP_THEME_CSS_VARIABLE_NAMES: readonly string[] = Object.values(APP_THEME_CSS_VARIABLES);");
  }
  return lines.join("\n") + "\n";
}

/** 应用 CSS：`:root` 是默认 preset，`:root[data-app-theme="dark"]` 是暗色首帧回退。 */
function renderAppCss(defaultPreset, darkPreset) {
  const lines = [];
  lines.push("/* 由 scripts/generate-theme-tokens.mjs 生成，请勿手工编辑。 */");
  lines.push("/* canonical source: web/contracts/src/theme/app-theme.default.json（:root） */");
  lines.push("/* canonical source: web/contracts/src/theme/app-theme.dark.json（:root[data-app-theme=\"dark\"]） */");
  lines.push("/* 根级语义 token：Theme Provider 会用当前 preset 覆盖这些值。 */");
  lines.push(":root {");
  lines.push("  color-scheme: light;");
  for (const [group, names] of Object.entries(TOKEN_GROUPS)) {
    lines.push(`  /* ${group} */`);
    for (const name of names) {
      lines.push(`  ${cssVar(name)}: ${defaultPreset.tokens[name].toLowerCase()};`);
    }
  }
  lines.push("}");
  lines.push("");
  lines.push(':root[data-app-theme="dark"] {');
  lines.push("  color-scheme: dark;");
  for (const [group, names] of Object.entries(TOKEN_GROUPS)) {
    lines.push(`  /* ${group} */`);
    for (const name of names) {
      lines.push(`  ${cssVar(name)}: ${darkPreset.tokens[name].toLowerCase()};`);
    }
  }
  lines.push("}");
  return lines.join("\n") + "\n";
}

/** 官网 CSS：固定浅色，只输出默认 preset，不包含 dark 首帧规则。 */
function renderSiteCss(preset, consumerNote = "官网消费者：固定使用默认 preset，站点样式只引用这些变量或其派生值。") {
  const lines = [];
  lines.push("/* 由 scripts/generate-theme-tokens.mjs 生成，请勿手工编辑。 */");
  lines.push("/* canonical source: web/contracts/src/theme/app-theme.default.json */");
  lines.push(`/* ${consumerNote} */`);
  lines.push(":root {");
  for (const [group, names] of Object.entries(TOKEN_GROUPS)) {
    lines.push(`  /* ${group} */`);
    for (const name of names) {
      lines.push(`  ${cssVar(name)}: ${preset.tokens[name].toLowerCase()};`);
    }
  }
  lines.push("}");
  return lines.join("\n") + "\n";
}

function renderRs(preset, fp) {
  const lines = [];
  lines.push("// 由 scripts/generate-theme-tokens.mjs 生成，请勿手工编辑。");
  lines.push("// canonical source: web/contracts/src/theme/app-theme.default.json");
  lines.push("//!");
  lines.push("//! Rust 默认 preset：由 canonical preset 生成，供应用初始化与测试 factory 使用。");
  lines.push("//! 不再作为 scene 缺失 theme 的回退（scene 必须携带完整合法 theme）。");
  lines.push("//! 任何 token 与 canonical preset 不一致都会让 `--check` 失败。");
  lines.push("");
  lines.push(`pub(crate) const APP_THEME_SCHEMA_VERSION: &str = ${JSON.stringify(preset.version)};`);
  lines.push(`pub(crate) const APP_THEME_DEFAULT_ID: &str = ${JSON.stringify(preset.id)};`);
  lines.push(`pub(crate) const APP_THEME_DEFAULT_FINGERPRINT: &str = ${JSON.stringify(fp)};`);
  lines.push("");
  lines.push("/// `(token 名, 规范 hex)`；顺序与 canonical preset 一致。");
  lines.push("pub(crate) const APP_THEME_DEFAULT_TOKENS: &[(&str, &str)] = &[");
  for (const name of TOKEN_NAMES) {
    lines.push(`    (${JSON.stringify(name)}, ${JSON.stringify(preset.tokens[name].toLowerCase())}),`);
  }
  lines.push("];");
  return lines.join("\n") + "\n";
}

function writeOrCheck(path, content) {
  if (check) {
    let existing = null;
    try {
      existing = readFileSync(path, "utf8");
    } catch {
      fail(`生成物缺失：${path}`);
    }
    if (existing !== content) {
      fail(`生成物已漂移：${path}（运行 node scripts/generate-theme-tokens.mjs 重新生成）`);
    }
    return;
  }
  writeFileSync(path, content);
}

const defaultPreset = JSON.parse(readFileSync(CANONICAL_DEFAULT, "utf8"));
const darkPreset = JSON.parse(readFileSync(CANONICAL_DARK, "utf8"));
validatePreset(defaultPreset, "canonical default preset");
validatePreset(darkPreset, "canonical dark preset");
if (defaultPreset.id !== "default") fail("canonical default preset id 必须是 default");
if (darkPreset.id !== "dark") fail("canonical dark preset id 必须是 dark");

const defaultFingerprint = fingerprint(defaultPreset);
const darkFingerprint = fingerprint(darkPreset);

writeOrCheck(
  OUT_TS_DEFAULT,
  renderTs(defaultPreset, defaultFingerprint, {
    exportPrefix: "APP_THEME_DEFAULT",
    sourceFile: "app-theme.default.json",
    label: "默认",
    includeCssVariables: true
  })
);
writeOrCheck(
  OUT_TS_DARK,
  renderTs(darkPreset, darkFingerprint, {
    exportPrefix: "APP_THEME_DARK",
    sourceFile: "app-theme.dark.json",
    label: "暗色",
    includeCssVariables: false
  })
);
writeOrCheck(OUT_CSS, renderAppCss(defaultPreset, darkPreset));
writeOrCheck(OUT_RS, renderRs(defaultPreset, defaultFingerprint));

process.stdout.write(
  check
    ? `✓ theme tokens 一致（default ${defaultFingerprint}, dark ${darkFingerprint}）\n`
    : `✓ theme tokens 已生成（default ${defaultFingerprint}, dark ${darkFingerprint}）\n`
);
