/**
 * 画布切换器条目上的「协作」动作（canvas.catalog-item-action）。
 *
 * 呈现条件与「同步远端」互补——**已连接且条目已在远端**：
 * - 未连接时协作窗口读不到名单，摆一个注定失败的入口只是噪音；
 * - 仅本机画布还没有远端成员关系，协作无对象，先走「同步远端」。
 *
 * 点击只把「给哪张画布开窗口」交给宿主 Dialog Service，窗口本体与读写都在
 * collaborators-dialog.tsx 里；本文件不持有名单状态，也不发请求。
 */
import { useSyncExternalStore } from "react";
import type { ComponentType } from "react";
import type { CanvasCatalogItemActionProps } from "@woohaa3/frontend/extension-api";
import type { RemoteServerSnapshot } from "../shared.js";
import { isLocalOnlyCatalogEntry } from "./catalog-action.js";
import type { RemoteServerService } from "./remote.js";
import "./remote-server.css";

/** 打开协作窗口的动作签名；由 index.ts 接到 ctx.dialogs.open 上。 */
export type OpenCollaboratorsDialog = (input: { canvasId: string; title: string }) => void;

export type RemoteServerCollaboratorsActionProps = CanvasCatalogItemActionProps & {
  /** 与徽标、设置面板共用同一份连接状态；不另建读模型。 */
  service: RemoteServerService;
  openCollaborators: OpenCollaboratorsDialog;
};

export function RemoteServerCollaboratorsAction({
  service,
  entry,
  openCollaborators
}: RemoteServerCollaboratorsActionProps) {
  // 显式标注快照类型：扩展包对 React 类型是 peer/dev 依赖，跨包解析会推断不出泛型。
  const snapshot: RemoteServerSnapshot = useSyncExternalStore<RemoteServerSnapshot>(
    service.subscribe,
    service.getSnapshot,
    service.getSnapshot
  );

  if (snapshot.phase !== "connected") return null;
  // 仅本机画布没有远端成员关系：协作动作与「同步远端」互斥。
  if (isLocalOnlyCatalogEntry(entry)) return null;

  return (
    <span className="remote-server-catalog-action">
      <button
        type="button"
        className="remote-server-catalog-action__button"
        onClick={() => openCollaborators({ canvasId: entry.id, title: entry.title })}
        title="查看这张远端画布的协作者"
        data-testid="remote-server-collaborators-open"
      >
        协作
      </button>
    </span>
  );
}

/** canvas.catalog-item-action contribution 的 renderer 工厂（入口 .ts 不能有 JSX）。 */
export function createRemoteServerCollaboratorsActionRenderer(
  service: RemoteServerService,
  openCollaborators: OpenCollaboratorsDialog
): ComponentType<CanvasCatalogItemActionProps> {
  return function RemoteServerCollaboratorsActionRenderer(props: CanvasCatalogItemActionProps) {
    return <RemoteServerCollaboratorsAction service={service} openCollaborators={openCollaborators} {...props} />;
  };
}
