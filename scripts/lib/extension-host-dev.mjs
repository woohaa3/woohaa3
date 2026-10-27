/**
 * 开发者模式热重载编排（change: 2026-10-27-add-extension-dev-reload，3.x / D2、D6、D7）。
 *
 * 只做编排，不做决策：
 * 1. `dev-source-watch` 告诉我们「哪个扩展的哪个面变了」；
 * 2. 前端面 → `publishBrowserRelease({ upsert })` 重新登记 artifact，并给出该扩展的 token；
 * 3. 后端面 → 由调用方注入的 `swapBackend` 执行 `runtime.swap`（含 last-good 装回）；
 * 4. 两件事都完成后发出 reload 通知，前端据此重装实例。
 *
 * 通知**复用既有通道**（D8 / 3.3）：前端面重登记后，`publishBrowserRelease` 已经让站点快照里的
 * `extensionRelease` 指针变化，前端 `adoptRelease` 本来是「升级条目只提示重开画布」；
 * 开发者模式只需在这个出口额外带一句「这些 id 走原地重装」，不引入新协议、新事件名。
 *
 * 失败语义（D1 / D7）：任何一步失败只记录，**不**缓存为终态；下一次产物变化会重新尝试。
 */
import fs from "node:fs";
import path from "node:path";
import { startDevSourceWatch } from "./dev-source-watch.mjs";

/**
 * 读一个开发者扩展目录的身份（`extension.json` 优先，回落包名）。
 * 产物变了但声明被删/写坏时，不能让宿主去装配一个没有身份的目录。
 */
function readDevIdentity(extensionDir) {
  const descriptorFile = path.join(extensionDir, "extension.json");
  try {
    const descriptor = JSON.parse(fs.readFileSync(descriptorFile, "utf8"));
    if (typeof descriptor?.extensionId === "string" && descriptor.extensionId.trim()) {
      return descriptor.extensionId.trim();
    }
  } catch {
    /* 回落到包名 */
  }
  return null;
}

/**
 * 启动开发者模式热重载。
 *
 * @param {object} options
 * @param {string[]} options.devDirs 开发者登记目录
 * @param {(input: { extensionId: string; directory: string }) => Promise<{ releaseId: string; href: string; changed: boolean }>} options.publishBrowserRelease
 *   前端产物重登记（宿主既有能力）
 * @param {(extensionId: string, directory: string) => Promise<void>} [options.swapBackend]
 *   后端热切换；缺省表示该宿主不支持（只处理前端面）
 * @param {(event: { extensionId: string; directory: string; surfaces: string[]; browserChanged: boolean; backend: boolean }) => void} [options.onReload]
 *   reload 通知出口（由 API 层推给前端，携带 extensionId，前端据它调 `reloadExtension`）
 */
export function startDevReload({
  devDirs = [],
  publishBrowserRelease,
  swapBackend = null,
  onReload = () => {},
  log = () => {},
  debounceMs = 120,
  readIdentity = readDevIdentity,
  /** 测试注入；缺省 `fs.watch`。 */
  watch = undefined
} = {}) {
  /** 每个扩展最后一次成功的后端 token（last-good，D6）。 */
  const lastGoodToken = new Map();
  /**
   * token 单调序号：时间戳在同一毫秒内会重复，而重复的 token 意味着复用旧模块实例——
   * 那正好是热重载要避免的。序号保证同一进程内每次 swap 都拿到新 URL。
   */
  let tokenSequence = 0;
  let closed = false;

  const apply = async ({ extensionDir, surfaces }) => {
    const extensionId = readIdentity(extensionDir);
    if (!extensionId) {
      log({ event: "dev-reload-no-identity", extensionDir });
      return;
    }
    /** 前端产物是否真的换了内容；false 表示同内容重放，不需要重装。 */
    let browserChanged = false;
    let backend = false;

    // 前端面：重新登记 artifact。发布器按内容算 artifactId，同内容重放自然幂等（3.2）。
    if (surfaces.includes("browser")) {
      try {
        const published = await publishBrowserRelease({ upsert: [{ extensionId, directory: extensionDir }] });
        browserChanged = published.changed === true;
        log({ event: "dev-artifact-registered", extensionId, directory: extensionDir, releaseId: published.releaseId, changed: browserChanged });
      } catch (error) {
        // 产物不合法（例如构建写坏）：保留上一次可用产物，等下一次变化。
        log({ event: "dev-artifact-register-failed", extensionId, message: error instanceof Error ? error.message : String(error) });
        return;
      }
    }

    // 后端面：同样的目录 + 新 token = 新模块实例（D6）。token 用「本次变化时刻」，
    // 与产物内容无关也不影响正确性——旧 token 会被装回时复用。
    if (surfaces.includes("backend")) {
      if (!swapBackend) {
        log({ event: "dev-backend-unsupported", extensionId });
      } else {
        tokenSequence += 1;
        const token = `dev-${tokenSequence.toString(36)}-${Date.now().toString(36)}`;
        try {
          await swapBackend(extensionId, extensionDir, { token, previousToken: lastGoodToken.get(extensionId) ?? null });
          lastGoodToken.set(extensionId, token);
          backend = true;
          log({ event: "dev-backend-swapped", extensionId, token });
        } catch (error) {
          log({ event: "dev-backend-swap-failed", extensionId, message: error instanceof Error ? error.message : String(error) });
          return;
        }
      }
    }

    // 同内容重放且后端也没变：没有可生效的东西，不发指令（幂等，3.2）。
    if (!browserChanged && !backend) return;
    onReload({ extensionId, directory: extensionDir, surfaces, browserChanged, backend });
  };

  const handle = startDevSourceWatch({
    devDirs,
    debounceMs,
    log,
    ...(watch ? { watch } : {}),
    onChange: (event) => {
      if (closed) return undefined;
      return apply(event);
    }
  });

  return {
    watched: handle.watched,
    idle: () => handle.idle(),
    close() {
      closed = true;
      handle.close();
    }
  };
}
