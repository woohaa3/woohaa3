/**
 * 扩展品牌图形资产：从扩展包同步到宿主静态目录。
 *
 * 事实来源是**扩展包内的资产**（声明在 `extension.json` 的 `icon.asset`，例如 `./assets/icon.png`）：
 * 品牌图形属于插件自己，宿主目录只是它发布后的落地位置。因此：
 *
 * - 逻辑路径由约定派生：`/plugin-icons/<extensionId><扩展名>`（前缀见 contracts 的
 *   `PLUGIN_ICON_ASSET_PREFIX`，渲染时由前端补部署前缀）；
 * - 宿主的两条渲染路径都注入这个派生值，扩展源码不再写死 `/plugin-icons/xxx.png`：
 *   后端插件卡片（`extension-host.mjs` 的 `createHostPlugins`）与浏览器 metadata
 *   （`build-extension-browser.mjs`）；
 * - `web/frontend/public/plugin-icons/` 下的文件与 README 都是**生成物**，由本模块同步，
 *   `pnpm extensions:check` 校验漂移。
 *
 * 图形只用于在设置页标识对应的产品或服务（指名性使用），不代表合作、赞助或背书关系。
 */
import fs from "node:fs";
import path from "node:path";

/** 与 contracts 的 `PLUGIN_ICON_ASSET_PREFIX` 保持一致（宿主不 import 前端契约包）。 */
export const EXTENSION_ICON_PUBLIC_PREFIX = "/plugin-icons/";

const IMAGE_EXTENSIONS = new Set([".png", ".svg", ".jpg", ".jpeg", ".webp"]);

/**
 * 派生某个扩展的品牌图形逻辑路径。
 *
 * 没有 `icon.asset` 声明时返回 null（走语义图形名或通用兜底图标）。
 */
export function extensionIconPublicPath(descriptor, extensionId) {
  const asset = descriptor?.icon?.asset;
  if (typeof asset !== "string" || asset.length === 0) return null;
  const ext = path.extname(asset).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) return null;
  return `${EXTENSION_ICON_PUBLIC_PREFIX}${extensionId}${ext}`;
}

/** 解析声明资产的绝对路径（未声明时 null）。 */
export function extensionIconAssetFile(extensionDir, descriptor) {
  const asset = descriptor?.icon?.asset;
  if (typeof asset !== "string" || asset.length === 0) return null;
  return path.resolve(extensionDir, asset);
}

const README = `# 插件品牌图形（生成物）

这个目录由 \`scripts/lib/extension-icon-assets.mjs\` 从各扩展包内的品牌图形**同步生成**，不要手工编辑。

- 事实来源：扩展目录里的 \`extension.json\` → \`icon.asset\`（例如 \`web/extensions/ark-provider/assets/icon.png\`）。
- 逻辑路径约定：\`/plugin-icons/<extensionId><扩展名>\`，由宿主注入到后端插件卡片与浏览器 metadata。
- 新增/更换图形：把文件放进扩展包的 \`assets/\`，在 \`extension.json\` 里声明，然后跑
  \`pnpm -C web run icons:sync\`（或任意一次构建）；\`pnpm extensions:check\` 会校验这里的漂移。

图形只用于在设置页标识对应的产品或服务（指名性使用），不代表与该项目的合作、赞助或背书关系；
来源与许可记录在各扩展包的 \`assets/README.md\`。
`;

/**
 * 同步（或校验）全部声明的品牌图形。
 *
 * 返回 `{ written, unchanged, errors }`；`check: true` 时不写盘，只报告漂移。
 */
export function syncExtensionIconAssets({ repoRoot, extensions, check = false, logger = () => undefined } = {}) {
  const publicDir = path.join(repoRoot, "web", "frontend", "public", "plugin-icons");
  const errors = [];
  const written = [];
  const unchanged = [];
  if (!check) fs.mkdirSync(publicDir, { recursive: true });
  for (const extension of extensions) {
    const descriptor = extension.descriptor;
    if (!descriptor) continue;
    const publicPath = extensionIconPublicPath(descriptor, extension.extensionId);
    if (!publicPath) continue;
    const assetFile = extensionIconAssetFile(extension.dir, descriptor);
    const target = path.join(publicDir, path.basename(publicPath));
    if (!assetFile || !fs.existsSync(assetFile)) {
      errors.push(`${extension.extensionId}：声明的品牌图形不存在（${descriptor.icon.asset}）`);
      continue;
    }
    const source = fs.readFileSync(assetFile);
    const expected = { source, target };
    if (check) {
      if (!fs.existsSync(target) || !fs.readFileSync(target).equals(source)) {
        errors.push(`${extension.extensionId}：${path.relative(repoRoot, target)} 与扩展包内资产不一致（跑 pnpm -C web run icons:sync）`);
      } else unchanged.push(target);
      continue;
    }
    fs.writeFileSync(target, expected.source);
    written.push(target);
    logger({ event: "extension-icon-synced", extensionId: extension.extensionId, file: path.relative(repoRoot, target) });
  }
  const readmePath = path.join(publicDir, "README.md");
  if (check) {
    if (!fs.existsSync(readmePath) || fs.readFileSync(readmePath, "utf8") !== README) {
      errors.push(`${path.relative(repoRoot, readmePath)} 与生成内容不一致（跑 pnpm -C web run icons:sync）`);
    }
  } else {
    fs.mkdirSync(publicDir, { recursive: true });
    fs.writeFileSync(readmePath, README);
  }
  return { written, unchanged, errors };
}
