/**
 * 画布切换器条目上的「同步远端」动作（`canvas.catalog-item-action`）。
 *
 * 为什么需要它：接入远端后「所有本地画布自动同步」曾让用户在不知情的情况下把整库上传。
 * 现在登录只代表「远端可用」，每张画布必须由用户点一次才成为远端画布；这个按钮就是那次
 * 显式动作的唯一入口。
 *
 * 呈现条件刻意收得很窄——**已连接**且条目**仅本机**：
 * - 未连接时点它必然失败，摆一个注定失败的按钮只是噪音；
 * - 已在远端（`sources` 含 `remote`，或 `sync` 已不是 `local-only`）时不需要再启用，
 *   宿主目录里自有来源/同步徽标表达状态。
 *
 * 点击后的顺序是**先刷新目录、再切画布**：启用成功后宿主目录才会把来源改成远端；而首次
 * 推送要等画布在本机被加载才真正开始，所以最后把用户带到那张画布上。这里不轮询，进度由
 * 宿主目录的同步徽标表达。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ComponentType } from "react";
import type { CanvasCatalogItemActionProps } from "@woohaa3/frontend/extension-api";
import type { RemoteServerSnapshot } from "../shared.js";
import type { RemoteServerService } from "./remote.js";
import "./remote-server.css";

export type RemoteServerCatalogActionProps = CanvasCatalogItemActionProps & {
  /** 与徽标、设置面板共用同一份连接状态；不另建读模型。 */
  service: RemoteServerService;
};

/**
 * 条目是否「仅本机」。
 *
 * `sources` 缺省按旧响应兼容口径视为只有本机；`sync` 缺省表示目录没接入远端（纯本地
 * 部署）。两者都必须指向「本地独有」，任何远端痕迹都让动作消失。
 */
export function isLocalOnlyCatalogEntry(entry: CanvasCatalogItemActionProps["entry"]): boolean {
  if (entry.sources?.includes("remote")) return false;
  return entry.sync === undefined || entry.sync === "local-only";
}

export function RemoteServerCatalogAction({
  service,
  entry,
  openCanvas,
  refreshCatalog
}: RemoteServerCatalogActionProps) {
  // 显式标注快照类型：扩展包对 React 类型是 peer/dev 依赖，跨包解析会推断不出泛型。
  const snapshot: RemoteServerSnapshot = useSyncExternalStore<RemoteServerSnapshot>(
    service.subscribe,
    service.getSnapshot,
    service.getSnapshot
  );
  const [pending, setPending] = useState(false);
  /** 面向人的失败原因；非 null 时在按钮旁显示，并允许重试。 */
  const [error, setError] = useState<string | null>(null);
  /**
   * 防重入。
   *
   * `pending` 的 state 更新要等下一次渲染；第二次点击若发生在同一帧里仍会进到处理函数，
   * 于是同一张画布会发两次启用请求。用 ref 做即时门闩，state 只负责呈现。
   */
  const inFlight = useRef(false);
  /**
   * 目录不轮询、宿主也没有「资产同步完成」的推送：媒体仍在补传时由这个动作短轮询目录，
   * 直到徽标离开 `syncing`。只在本条目处于同步中时开定时器，组件卸载即停。
   */
  const syncing = entry.sync === "syncing";
  useEffect(() => {
    if (!syncing) return;
    let stopped = false;
    const timer = setInterval(() => {
      if (!stopped) void refreshCatalog().catch(() => undefined);
    }, 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [syncing, refreshCatalog]);

  const enable = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);

    const result = await service.api.enableCanvasSync(entry.id);
    if (!result.ok) {
      inFlight.current = false;
      setPending(false);
      setError(result.error);
      return;
    }

    // 先刷新目录：来源与同步徽标由宿主目录读模型产生，不刷新的话条目还停在「仅本机」。
    // 刷新失败不改判——启用已经生效，下次打开目录会自然重读；不能把成功说成失败，也不能
    // 因此不切画布。
    try {
      await refreshCatalog();
    } catch {
      // 目录刷新是展示层动作，失败不影响已生效的启用。
    }

    inFlight.current = false;
    setPending(false);
    // 首次推送要等这张画布在本机被加载，所以最后切过去。
    openCanvas(entry.id);
  }, [entry.id, openCanvas, refreshCatalog, service]);

  if (snapshot.phase !== "connected") return null;
  // 已在远端但媒体还在补传：只表达状态，不再给「同步远端」按钮。
  if (!isLocalOnlyCatalogEntry(entry)) {
    if (!syncing) return null;
    return (
      <span className="remote-server-catalog-action" data-testid="remote-server-catalog-syncing">
        <span className="remote-server-catalog-action__syncing" title="文档已到远端，正在补传画布媒体">
          同步中…
        </span>
      </span>
    );
  }

  return (
    <span className="remote-server-catalog-action">
      <button
        type="button"
        className="remote-server-catalog-action__button"
        disabled={pending}
        onClick={() => void enable()}
        title={error ?? "把这张仅本机的画布同步到远端"}
        data-testid="remote-server-catalog-sync"
      >
        {pending ? "同步中…" : "同步远端"}
      </button>
      {error ? (
        <span className="remote-server-catalog-action__error" data-testid="remote-server-catalog-error">
          {error}
        </span>
      ) : null}
    </span>
  );
}

/**
 * `canvas.catalog-item-action` contribution 的 renderer 工厂。
 *
 * 入口 `index.ts` 是 `.ts`（扫描入口直接读取它，不能出现 JSX），所以 JSX 留在本文件里，
 * 与 `createRemoteServerBadgeRenderer` 同一分工。返回的是组件类型：宿主为**每个条目**
 * 渲染这份贡献。
 */
export function createRemoteServerCatalogActionRenderer(
  service: RemoteServerService
): ComponentType<CanvasCatalogItemActionProps> {
  return function RemoteServerCatalogActionRenderer(props: CanvasCatalogItemActionProps) {
    return <RemoteServerCatalogAction service={service} {...props} />;
  };
}
