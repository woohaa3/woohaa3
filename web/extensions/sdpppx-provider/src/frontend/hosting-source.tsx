/**
 * 能力中心「临时图床 → SDPPPX 临时图床 → 配置」里的来源面板。
 *
 * 临时图床的就绪条件不是可编辑配置项，而是 SDPPPX 登录态。宿主只提供通用
 * `agent-assistant.hosting-source` 贡献位，`HostingOwnerConfiguration` 按候选 owner 找到这里，
 * 因此不需要按扩展 ID 写宿主分支。
 *
 * 只读要求：挂载时只读一次已缓存的会话快照，不发起登录、不上传；用户点「登录」或「管理账号」
 * 时才走既有账号入口。
 */
import { useEffect, useRef, useSyncExternalStore, type ReactElement } from "react";
import { Button } from "@woohaa3/ui/primitives";
import type { SdpppxSessionSnapshot } from "../shared.js";
import type { SdpppxAccountService } from "./account-service.js";

export type SdpppxHostingSourceProps = {
  service: SdpppxAccountService;
  onOpenLogin: () => void;
  onOpenAccount: () => void;
  /** 登录态真正变化后刷新能力中心的权威路由快照；不触发上传。 */
  onSaved?: () => void;
};

export function SdpppxHostingSource({ service, onOpenLogin, onOpenAccount, onSaved }: SdpppxHostingSourceProps) {
  const snapshot: SdpppxSessionSnapshot = useSyncExternalStore<SdpppxSessionSnapshot>(
    service.subscribe,
    service.getSnapshot,
    service.getSnapshot
  );
  const authenticated = snapshot.status === "authenticated";
  const previous = useRef(authenticated);

  useEffect(() => {
    // 只在「未登录 → 已登录」时刷新一次快照：登出后由下一次显式查询重新投影，
    // 这里不主动上传，也不把旧账号的成功当成可用证明。
    if (authenticated && !previous.current) {
      previous.current = true;
      onSaved?.();
    } else if (!authenticated) {
      previous.current = false;
    }
  }, [authenticated, onSaved]);

  if (authenticated && snapshot.session) {
    const name = snapshot.session.displayName?.trim() || "已登录";
    return (
      <div className="sdpppx-hosting-source" data-testid="sdpppx-hosting-source" data-state="authenticated">
        <p>已登录 {name}，登录态有效时可用于图片与视频的临时外链。</p>
        <Button size="sm" tone="neutral" onClick={onOpenAccount}>管理账号</Button>
      </div>
    );
  }

  const expired = snapshot.notice === "sdpppx-session-expired";
  return (
    <div className="sdpppx-hosting-source" data-testid="sdpppx-hosting-source" data-state={expired ? "expired" : "anonymous"}>
      <p>{expired ? "SDPPPX 登录已过期，重新登录后恢复临时图床。" : "登录 SDPPPX 后可使用临时图床。"}</p>
      <Button size="sm" tone="primary" onClick={onOpenLogin}>{expired ? "重新扫码" : "微信扫码登录"}</Button>
    </div>
  );
}

export function createSdpppxHostingSourceRenderer(
  service: SdpppxAccountService,
  onOpenLogin: () => void,
  onOpenAccount: () => void
): (props: { onSaved?: () => void }) => ReactElement {
  return ({ onSaved }) => (
    <SdpppxHostingSource service={service} onOpenLogin={onOpenLogin} onOpenAccount={onOpenAccount} onSaved={onSaved} />
  );
}
