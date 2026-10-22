/**
 * 「协作」窗口：邀请协作者（服务端签发链接）+ 只读协作者名单。
 *
 * 四条边界：
 * - **邀请由服务端签发**：链接形如 `<public_base_url>/invite/<token>`，创建返回什么 url 就
 *   展示/复制什么，客户端**不**用 location.origin 拼（对外地址只有部署侧知道）；
 * - **配置缺失如实说**：url 为空表示部署没配对外地址，界面提示「无法生成链接」并**不提供
 *   复制**，而不是退回一个必然打不开的本地地址；
 * - **邀请是管理动作**：能不能创建/撤销沿用成员读模型的 canManage（服务端结论：作者或部署
 *   管理员）；不可管理的人不渲染邀请区（服务端也会拒绝这类读取）；
 * - **名单只读**：精确到某个人的成员授权留在管理端，这里只展示名单。
 *
 * 打开时读一次成员名单（写操作开关来自它）；canManage 时再读邀请列表。之后不轮询：
 * 两者都只由用户动作驱动。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  objectPayload
} from "@woohaa3/frontend/extension-api";
import type { DialogDefinition, DialogRendererProps } from "@woohaa3/frontend/extension-api";
import {
  REMOTE_CANVAS_INVITE_DEFAULT_EXPIRY_SECONDS,
  REMOTE_CANVAS_INVITE_EXPIRY_PRESETS,
  type RemoteCanvasInvite,
  type RemoteCanvasInviteCreateResult,
  type RemoteCanvasInviteCreated,
  type RemoteCanvasInviteExpirySeconds,
  type RemoteCanvasInviteRevokeResult,
  type RemoteCanvasInvitesResult,
  type RemoteCanvasMembersResult,
  type RemoteCanvasMemberView,
  type RemoteCanvasRole
} from "../shared.js";
import "./remote-server.css";

export const REMOTE_SERVER_COLLABORATORS_DIALOG_ID = "remote-server-collaborators";

/** dialog payload：画布 id 必需，标题只用于窗口标题。 */
export type RemoteCollaboratorsPayload = {
  canvasId: string;
  title: string;
};

/** 两档角色只在这里翻译成中文：界面不另造第三档，也不把 proto 枚举名泄漏给人。 */
const ROLE_LABEL: Record<RemoteCanvasRole, string> = {
  viewer: "只读协同",
  editor: "可写协同"
};

/** 邀请状态：撤销优先于过期（一条已撤销的邀请不必再说它过期）。 */
const INVITE_STATUS_LABEL = {
  valid: "有效",
  revoked: "已撤销",
  expired: "已过期"
} as const;

type InviteStatus = keyof typeof INVITE_STATUS_LABEL;

/** 协作窗口只需要读名单与邀请的读写；用结构类型便于测试注入替身。 */
export type RemoteCollaboratorsDialogService = {
  api: {
    loadCanvasMembers(canvasId: string): Promise<RemoteCanvasMembersResult>;
    loadCanvasInvites(canvasId: string): Promise<RemoteCanvasInvitesResult>;
    createCanvasInvite(input: {
      canvasId: string;
      role: RemoteCanvasRole;
      expiresInSeconds: number;
    }): Promise<RemoteCanvasInviteCreateResult>;
    revokeCanvasInvite(input: {
      canvasId: string;
      inviteId: string;
    }): Promise<RemoteCanvasInviteRevokeResult>;
  };
};

export const remoteServerCollaboratorsDialogDefinition: DialogDefinition = {
  dismissible: true,
  singleton: true,
  size: "lg",
  variant: "standard",
  validatePayload: objectPayload<RemoteCollaboratorsPayload>(REMOTE_SERVER_COLLABORATORS_DIALOG_ID, (value) => {
    const canvasId = value.canvasId;
    if (typeof canvasId !== "string" || canvasId.trim() === "") return null;
    return { canvasId: canvasId.trim(), title: typeof value.title === "string" ? value.title : "" };
  })
};

/** 时间：本地「YYYY-MM-DD HH:mm」，固定格式便于纵向对齐（不交给 locale）。 */
export function formatMemberGrantedAt(value: string): string {
  if (value === "") return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (input: number) => String(input).padStart(2, "0");
  return (
    date.getFullYear() +
    "-" +
    pad(date.getMonth() + 1) +
    "-" +
    pad(date.getDate()) +
    " " +
    pad(date.getHours()) +
    ":" +
    pad(date.getMinutes())
  );
}

/**
 * 一条邀请在当前时刻的状态。
 *
 * 过期用 expires_at 与当前时间比，不依赖服务端的读取时刻：人可能把窗口开着很久。
 * 撤销优先——撤销过的邀请即使还没到期也不该显示成「有效」。
 */
export function inviteStatusOf(invite: RemoteCanvasInvite, now: number = Date.now()): InviteStatus {
  if (invite.revoked) return "revoked";
  const expiresAt = Date.parse(invite.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt <= now) return "expired";
  return "valid";
}

type MembersState = {
  /** 最近一次读成功的名单；读失败但已有旧数据时保留它并单独提示错误。 */
  view: RemoteCanvasMemberView | null;
  error: string | null;
  loading: boolean;
};

type InvitesState = {
  /** 最近一次读成功的邀请列表；读失败时保留旧数据并单独提示错误。 */
  list: RemoteCanvasInvite[] | null;
  error: string | null;
  loading: boolean;
};

type CopyFeedback = { tone: "success" | "danger"; text: string };

export type RemoteServerCollaboratorsDialogProps = {
  service: RemoteCollaboratorsDialogService;
  canvasId: string;
  /** 画布标题（来自目录条目）；空时窗口标题退化为画布 id。 */
  title?: string;
  /** 实例 id（用于标题的 labelledBy）；独立渲染时给个稳定值即可。 */
  instanceId?: string;
  /** 关闭回调；不传时（独立渲染/测试）不渲染关闭动作。 */
  onClose?: () => void;
};

export function RemoteServerCollaboratorsDialog({
  service,
  canvasId,
  title,
  instanceId,
  onClose
}: RemoteServerCollaboratorsDialogProps) {
  const [members, setMembers] = useState<MembersState>({ view: null, error: null, loading: true });
  const [invites, setInvites] = useState<InvitesState>({ list: null, error: null, loading: false });
  const [draftRole, setDraftRole] = useState<RemoteCanvasRole>("viewer");
  const [draftExpiry, setDraftExpiry] = useState<RemoteCanvasInviteExpirySeconds>(
    REMOTE_CANVAS_INVITE_DEFAULT_EXPIRY_SECONDS
  );
  const [createPending, setCreatePending] = useState(false);
  /** 最近一次创建成功的邀请；null 表示还没有创建或已撤销。 */
  const [created, setCreated] = useState<RemoteCanvasInviteCreated | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback | null>(null);

  const alive = useRef(true);
  /** 当前画布：异步结果回来时若已切到别的画布，丢弃旧结果。 */
  const canvasRef = useRef(canvasId);
  /** 读写在途标记：state 更新是异步的，连点不能叠出第二次请求。 */
  const membersInflight = useRef(false);
  const invitesInflight = useRef(false);
  const createInflight = useRef(false);
  const revokeInflight = useRef(false);

  const readInvites = useCallback(async () => {
    if (invitesInflight.current) return;
    invitesInflight.current = true;
    setInvites((previous) => ({ ...previous, loading: true }));
    const result = await service.api.loadCanvasInvites(canvasId);
    invitesInflight.current = false;
    if (!alive.current || canvasRef.current !== canvasId) return;
    if (result.ok) {
      setInvites({ list: result.invites, error: null, loading: false });
    } else {
      // 失败不清掉上一次成功读到的列表：一次读失败不该让已看到的邀请消失。
      setInvites((previous) => ({ list: previous.list, error: result.error, loading: false }));
    }
  }, [canvasId, service]);

  const readMembers = useCallback(async () => {
    if (membersInflight.current) return;
    membersInflight.current = true;
    const result = await service.api.loadCanvasMembers(canvasId);
    membersInflight.current = false;
    if (!alive.current || canvasRef.current !== canvasId) return;
    if (result.ok) {
      setMembers({ view: result, error: null, loading: false });
      // 邀请区只对可管理的人渲染；列表也只在那一刻读，普通人不会触发注定被拒的调用。
      if (result.canManage) void readInvites();
    } else {
      // 失败不清掉上一次成功的数据：一次读失败不该让已经看到的名单消失。
      setMembers((previous) => ({ view: previous.view, error: result.error, loading: false }));
    }
  }, [canvasId, readInvites, service]);

  useEffect(() => {
    alive.current = true;
    canvasRef.current = canvasId;
    // 画布换了（singleton 窗口被重新 open 到另一张画布）：清掉上一张的名单、邀请与临时状态，
    // 避免在新画布标题下短暂显示旧数据。
    setMembers({ view: null, error: null, loading: true });
    setInvites({ list: null, error: null, loading: false });
    setDraftRole("viewer");
    setDraftExpiry(REMOTE_CANVAS_INVITE_DEFAULT_EXPIRY_SECONDS);
    setCreated(null);
    setRevokingId(null);
    setActionError(null);
    setNotice(null);
    setCopyFeedback(null);
    void readMembers();
    return () => {
      alive.current = false;
    };
  }, [canvasId, readMembers]);

  const createInvite = useCallback(async () => {
    if (createInflight.current) return;
    createInflight.current = true;
    setCreatePending(true);
    setActionError(null);
    setNotice(null);
    setCopyFeedback(null);
    const result = await service.api.createCanvasInvite({
      canvasId,
      role: draftRole,
      expiresInSeconds: draftExpiry
    });
    createInflight.current = false;
    if (!alive.current || canvasRef.current !== canvasId) return;
    setCreatePending(false);
    if (!result.ok) {
      setActionError(result.error);
      return;
    }
    // url 原样保存：它是服务端按部署配置拼好的地址。空串不是失败，而是「没有对外地址」，
    // 由界面在展示处说明（见下方 created.url === "" 的分支）。
    setCreated({ inviteId: result.inviteId, role: result.role, expiresAt: result.expiresAt, url: result.url });
    // 列表对账：邀请确实已签发（即便没有 url），不该在列表里缺席。
    await readInvites();
  }, [canvasId, draftExpiry, draftRole, readInvites, service]);

  const copyCreatedLink = useCallback(async () => {
    if (created === null || created.url === "") return;
    setCopyFeedback(null);
    const clipboard = globalThis.navigator?.clipboard;
    if (clipboard === undefined || typeof clipboard.writeText !== "function") {
      setCopyFeedback({ tone: "danger", text: "当前环境不支持剪贴板，请手动选择上面的链接复制" });
      return;
    }
    try {
      await clipboard.writeText(created.url);
      if (!alive.current) return;
      setCopyFeedback({ tone: "success", text: "已复制" });
    } catch (error) {
      if (!alive.current) return;
      const reason = error instanceof Error && error.message !== "" ? error.message : "剪贴板不可用";
      setCopyFeedback({ tone: "danger", text: "复制失败：" + reason });
    }
  }, [created]);

  const revokeInvite = useCallback(
    async (inviteId: string) => {
      if (revokeInflight.current) return;
      revokeInflight.current = true;
      setRevokingId(inviteId);
      setActionError(null);
      setNotice(null);
      const result = await service.api.revokeCanvasInvite({ canvasId, inviteId });
      revokeInflight.current = false;
      if (!alive.current || canvasRef.current !== canvasId) return;
      setRevokingId(null);
      if (!result.ok) {
        setActionError(result.error);
        return;
      }
      setNotice("邀请已撤销");
      // 撤销的是刚创建的那条：链接已经失效，不能继续提供复制。
      setCreated((previous) => (previous?.inviteId === inviteId ? null : previous));
      await readInvites();
    },
    [canvasId, readInvites, service]
  );

  const view = members.view;
  const canManage = view?.canManage === true;
  // 完整名单只在 complete=true 时展示：普通协作者拿到的只有自己那一条。
  const showMembers = view !== null && view.complete;
  const heading = title !== undefined && title !== "" ? title : canvasId;
  const instance = instanceId ?? REMOTE_SERVER_COLLABORATORS_DIALOG_ID;
  const titleId = instance + "-title";
  const now = Date.now();

  return (
    <Dialog.Content
      variant="standard"
      size="lg"
      labelledBy={titleId}
      instanceId={instance}
      {...(onClose ? { onOverlayClick: onClose } : {})}
    >
      <DialogHeader {...(onClose ? { onClose } : {})}>
        <DialogTitle id={titleId}>{"协作 · " + heading}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="remote-server-collaborators__note">
          协作邀请由服务端签发：创建后把链接发给同事，对方登录本部署后即可接受。精确到某个人的成员授权在管理端完成，这里只展示名单。
        </p>

        {canManage ? (
          <>
            <h3 className="remote-server-collaborators__section-title">邀请协作者</h3>
            <section className="remote-server-collaborators__invite" data-testid="remote-server-collaborators-invites">
              <form
                className="remote-server-collaborators__invite-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void createInvite();
                }}
              >
                <label className="remote-server-collaborators__invite-field">
                  <span className="remote-server-collaborators__invite-label">角色</span>
                  <select
                    className="remote-server-collaborators__invite-select"
                    value={draftRole}
                    onChange={(event) => setDraftRole(event.currentTarget.value === "editor" ? "editor" : "viewer")}
                    data-testid="remote-server-invite-role"
                  >
                    <option value="viewer">{ROLE_LABEL.viewer}</option>
                    <option value="editor">{ROLE_LABEL.editor}</option>
                  </select>
                </label>
                <label className="remote-server-collaborators__invite-field">
                  <span className="remote-server-collaborators__invite-label">有效期</span>
                  <select
                    className="remote-server-collaborators__invite-select"
                    value={String(draftExpiry)}
                    onChange={(event) => {
                      const next = Number(event.currentTarget.value);
                      const preset = REMOTE_CANVAS_INVITE_EXPIRY_PRESETS.find((entry) => entry.seconds === next);
                      if (preset) setDraftExpiry(preset.seconds);
                    }}
                    data-testid="remote-server-invite-expiry"
                  >
                    {REMOTE_CANVAS_INVITE_EXPIRY_PRESETS.map((preset) => (
                      <option key={preset.seconds} value={preset.seconds}>
                        {preset.label}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  size="sm"
                  tone="primary"
                  type="submit"
                  disabled={createPending}
                  loading={createPending}
                  data-testid="remote-server-invite-create"
                >
                  {createPending ? "创建中…" : "创建邀请链接"}
                </Button>
              </form>

              {created !== null ? (
                created.url === "" ? (
                  <p className="remote-server-collaborators__error" data-testid="remote-server-invite-url-error">
                    服务端未配置对外地址，无法生成链接
                  </p>
                ) : (
                  <>
                    <div className="remote-server-collaborators__invite-link">
                      <input
                        className="remote-server-collaborators__invite-link-input"
                        value={created.url}
                        readOnly
                        onFocus={(event) => event.currentTarget.select()}
                        data-testid="remote-server-invite-url"
                      />
                      <Button size="sm" onClick={() => void copyCreatedLink()} data-testid="remote-server-invite-copy">
                        复制链接
                      </Button>
                    </div>
                    <p className="remote-server-collaborators__invite-expires" data-testid="remote-server-invite-expires">
                      到期时间：{formatMemberGrantedAt(created.expiresAt)}
                    </p>
                  </>
                )
              ) : null}

              {copyFeedback !== null ? (
                <p
                  className="remote-server-collaborators__invite-feedback"
                  data-tone={copyFeedback.tone}
                  data-testid="remote-server-invite-copy-feedback"
                >
                  {copyFeedback.text}
                </p>
              ) : null}

              {actionError !== null ? (
                <p className="remote-server-collaborators__error" data-testid="remote-server-invite-action-error">
                  {actionError}
                </p>
              ) : null}

              {notice !== null ? (
                <p
                  className="remote-server-collaborators__invite-feedback"
                  data-tone="success"
                  data-testid="remote-server-invite-notice"
                >
                  {notice}
                </p>
              ) : null}

              <p className="remote-server-collaborators__invite-note" data-testid="remote-server-invite-note">
                链接由服务端生成；对方需要登录本部署才能接受。邀请到期或被撤销后失效；已接受的人不会因撤销被移除。
              </p>

              <h4 className="remote-server-collaborators__invite-subtitle">已创建的邀请</h4>

              {invites.loading && invites.list === null ? (
                <p className="remote-server-collaborators__status" data-testid="remote-server-invites-loading">
                  正在读取邀请…
                </p>
              ) : null}

              {invites.error !== null ? (
                <p className="remote-server-collaborators__error" data-testid="remote-server-invites-error">
                  读取邀请失败：{invites.error}
                </p>
              ) : null}

              {invites.list !== null && invites.list.length > 0 ? (
                <table className="remote-server-collaborators__table" data-testid="remote-server-invites">
                  <thead>
                    <tr>
                      <th>角色</th>
                      <th>到期时间</th>
                      <th>接受次数</th>
                      <th>状态</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invites.list.map((invite) => {
                      const status = inviteStatusOf(invite, now);
                      return (
                        <tr
                          key={invite.inviteId}
                          className="remote-server-collaborators__row"
                          data-testid="remote-server-invite-row"
                        >
                          <td>{ROLE_LABEL[invite.role]}</td>
                          <td>{formatMemberGrantedAt(invite.expiresAt)}</td>
                          <td>{invite.acceptedCount}</td>
                          <td data-testid="remote-server-invite-status" data-status={status}>
                            {INVITE_STATUS_LABEL[status]}
                          </td>
                          <td>
                            {status === "valid" ? (
                              <Button
                                size="sm"
                                tone="danger"
                                disabled={revokingId === invite.inviteId}
                                loading={revokingId === invite.inviteId}
                                onClick={() => void revokeInvite(invite.inviteId)}
                                data-testid="remote-server-invite-revoke"
                              >
                                {revokingId === invite.inviteId ? "撤销中…" : "撤销"}
                              </Button>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : null}

              {invites.list !== null && invites.list.length === 0 ? (
                <p className="remote-server-collaborators__empty" data-testid="remote-server-invites-empty">
                  还没有创建邀请。
                </p>
              ) : null}
            </section>
          </>
        ) : null}

        <h3 className="remote-server-collaborators__section-title">协作者名单</h3>

        {members.loading && view === null ? (
          <p className="remote-server-collaborators__status" data-testid="remote-server-collaborators-loading">
            正在读取名单…
          </p>
        ) : null}

        {members.error !== null ? (
          <p className="remote-server-collaborators__error" data-testid="remote-server-collaborators-error">
            读取失败：{members.error}
          </p>
        ) : null}

        {view !== null ? (
          <dl className="remote-server-collaborators__summary" data-testid="remote-server-collaborators-summary">
            <dt>作者</dt>
            <dd data-testid="remote-server-collaborators-owner">{view.owner !== "" ? view.owner : "无属主"}</dd>
            <dt>我的角色</dt>
            <dd data-testid="remote-server-collaborators-role">
              {view.isOwner ? "你是作者" : ROLE_LABEL[view.role]}
            </dd>
          </dl>
        ) : null}

        {showMembers && view.members.length > 0 ? (
          <table className="remote-server-collaborators__table" data-testid="remote-server-collaborators-members">
            <thead>
              <tr>
                <th>主体</th>
                <th>角色</th>
                <th>授予者</th>
                <th>授予时间</th>
              </tr>
            </thead>
            <tbody>
              {view.members.map((member) => (
                <tr key={member.actorId} className="remote-server-collaborators__row" data-testid="remote-server-collaborator-row">
                  <td className="remote-server-collaborators__actor" data-testid="remote-server-collaborator-actor">
                    {member.actorId}
                  </td>
                  <td>{ROLE_LABEL[member.role]}</td>
                  <td>{member.grantedBy !== "" ? member.grantedBy : "—"}</td>
                  <td>{formatMemberGrantedAt(member.grantedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}

        {showMembers && view.members.length === 0 ? (
          <p className="remote-server-collaborators__empty" data-testid="remote-server-collaborators-empty">
            还没有协作者。
          </p>
        ) : null}

        {view !== null && !showMembers ? (
          <p className="remote-server-collaborators__notice" data-testid="remote-server-collaborators-partial">
            只有作者或部署管理员能查看完整名单。你在这张画布上是{ROLE_LABEL[view.role]}。
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter>
        {onClose ? (
          <Button size="sm" onClick={onClose} data-testid="remote-server-collaborators-close">
            关闭
          </Button>
        ) : null}
      </DialogFooter>
    </Dialog.Content>
  );
}

/** Dialog Service 渲染器：payload 里的画布 id / 标题来自目录条目。 */
export function createRemoteServerCollaboratorsDialogRenderer(service: RemoteCollaboratorsDialogService) {
  return function RemoteServerCollaboratorsDialogRenderer({ instance, requestClose }: DialogRendererProps) {
    const payload = instance.payload as RemoteCollaboratorsPayload;
    return (
      <RemoteServerCollaboratorsDialog
        service={service}
        canvasId={payload.canvasId}
        title={payload.title}
        instanceId={instance.instanceId}
        onClose={requestClose}
      />
    );
  };
}
