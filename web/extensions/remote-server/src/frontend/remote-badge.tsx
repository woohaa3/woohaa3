/**
 * 顶栏「远端接入」徽标（`canvas.topbar`）。
 *
 * 为什么需要它：远端账号/链路状态是**全局的**，而 /server 页面是偶发打开的。若只在页面里
 * 显示，用户永远不知道这台机器到底有没有接上远端服务端。
 *
 * 作用域必须写清楚：四相标签都带「远端」限定词——它描述的是**宿主↔远端服务端的账号/链路**，
 * 不是某张画布的实时同步。画布有没有连上、是不是只读，以右下角同步气泡为准；否则
 * 「远端已接入」会被读成「画布已连接」，与断线只读的提示同屏自相矛盾。
 *
 * 四相刻意分开：本地（灰）/ 已接入（绿）/ 异常（红）/ 建连中（黄）。本地不是错误，
 * 所以不用警示色；点击进入 /server 页面处理。
 */
import { useSyncExternalStore } from "react";
import type { ReactElement } from "react";
import type { RemoteServerService } from "./remote.js";

const LABEL: Record<string, string> = {
  local: "本地模式",
  connected: "远端已接入",
  error: "远端异常",
  connecting: "远端连接中"
};

/** 悬停说明里的作用域提示：这个徽标不回答「画布有没有连上」。 */
const SCOPE_HINT = "画布同步状态以右下角为准";

export type RemoteServerBadgeProps = {
  service: RemoteServerService;
  /** 打开本扩展的设置面板（点击徽标）；未注入时徽标只读。 */
  onOpen?: () => void;
};

export function RemoteServerBadge({ service, onOpen }: RemoteServerBadgeProps) {
  const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);
  const label = LABEL[snapshot.phase] ?? "本地模式";
  const detail =
    snapshot.phase === "connected"
      ? `${snapshot.serverUrl ?? ""}${snapshot.subject ? ` · ${snapshot.displayName ?? snapshot.subject}` : ""}`
      : snapshot.phase === "error"
        ? (snapshot.error ?? "无法连接服务端")
        : "只在本地保存";
  // 标题里同时给出「描述的是远端账号/链路」与「画布状态看右下角」，避免两处指示打架。
  const title = onOpen
    ? `远端服务端账号/链路：${detail}（${SCOPE_HINT}；点击管理）`
    : `远端服务端账号/链路：${detail}（${SCOPE_HINT}）`;
  const className = `remote-server-badge is-${snapshot.phase}${onOpen ? " is-clickable" : ""}`;
  const content = (
    <>
      <span className="remote-server-badge__dot" aria-hidden="true" />
      <span className="remote-server-badge__label">{label}</span>
    </>
  );
  if (!onOpen) {
    return (
      <span className={className} title={title} data-testid="remote-server-badge" data-phase={snapshot.phase}>
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={className}
      title={title}
      onClick={onOpen}
      data-testid="remote-server-badge"
      data-phase={snapshot.phase}
    >
      {content}
    </button>
  );
}

/** `canvas.topbar` contribution 的 renderer 工厂（`.ts` 入口不能写 JSX）。 */
export function createRemoteServerBadgeRenderer(service: RemoteServerService, onOpen?: () => void): () => ReactElement {
  return () => <RemoteServerBadge service={service} {...(onOpen ? { onOpen } : {})} />;
}
