/**
 * 运行期浏览器发布目录（change: 2026-10-21-add-extension-marketplace-point，任务 6.1 / design D8）。
 *
 * 启动期按已构建 browser 产物算出首个 release；受管扩展安装/卸载后经 `publish` 重算，旧 release
 * 与旧 artifact 继续托管到进程退出。从 `extension-host.mjs` 拆出，行为不变。
 */
import { buildBrowserRelease, createBrowserReleasePublisher } from "./extension-release-catalog.mjs";

/**
 * 构建首个 release 与发布器，并返回宿主对象需要的发布相关成员（`browserRelease` 是 getter，
 * 读取方每次拿到当前值）。`relocate` 供目录改名时搬移托管文件路径。
 */
export async function createReleaseFacade({ artifacts, repoRoot, contracts, logger }) {
  // 运行期发布目录（design D4/D7）：读已构建 browser 产物，复用旧装配器口径算 releaseId 与
  // artifactId 路径映射，并在内存里托管；构建产物不再被就地改写。
  const browserRelease = await buildBrowserRelease({ artifacts, repoRoot, contracts, logger });
  const releasePublisher = createBrowserReleasePublisher({ release: browserRelease, artifacts, repoRoot, contracts, logger });
  return {
    relocate: (from, to) => releasePublisher.relocate(from, to),
    members: {
      /** 当前发布目录（随 `publishBrowserRelease` 切换；读取方每次取最新值）。 */
      get browserRelease() {
        return releasePublisher.current();
      },
      /**
       * 运行期重算发布目录（design D8）：`upsert` 按 extensionId 新增/替换（`directory` 为含
       * `browser-dist/` 的版本目录，没有 browser 产物的条目登记为 skipped），`remove` 删除条目。
       * 校验失败抛 `ExtensionReleaseError` 且当前 release 不变；同内容重放返回 `changed: false`。
       */
      publishBrowserRelease: (change) => releasePublisher.publish(change),
      /** 订阅发布切换（`{ releaseId, href }`）；返回退订函数。 */
      onBrowserReleaseChange: (listener) => releasePublisher.subscribe(listener),
      /** 托管 `/extension-releases/` 与 `/extensions/`；返回 `true` 表示已响应。 */
      handleReleaseRequest: (req, res) => releasePublisher.handler(req, res)
    }
  };
}
