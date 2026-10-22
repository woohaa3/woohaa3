/**
 * 设置弹窗 → 插件配置 → 服务端接入 的详情面板。
 *
 * 为什么不做成独立全屏页面：接入是「配一次、平时只用状态徽标」的低频操作，与本地/Agent
 * 配置同属插件详情；做成独立页面会让它看起来像一个业务区，且要独占一套 page scope 与路由。
 *
 * 面板职责与原 `/server` 页面一致——让「接哪台、以谁的身份、现在什么状态」一眼可见，并给出
 * 连接 / 断开两个动作。它**不承诺**远端会提供什么业务能力：这里只报接入状态与服务端目录的
 * 模型数量，具体模型由宿主快照投影到下方「生成的模型」区，与其它 Provider 一样按本机策略启停。
 *
 * 与页面的两点差异（都是设置语境的必然结果）：
 * - 没有「返回画布」按钮：`requestClose` 在这里表示「返回插件列表」，由宿主设置工作区注入；
 * - 地址输入是**未保存草稿**，必须经 `reportEditState` 汇入设置退出保护，否则关闭弹窗会静默
 *   丢掉用户刚敲的地址。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button, SettingsFeedback, SettingsSection, TextInput } from "@woohaa3/frontend/extension-api";
import {
  REMOTE_SERVER_OAUTH_POLL_INTERVAL_MS,
  REMOTE_SERVER_OAUTH_POLL_TIMEOUT_MS,
  isLoopbackHostname,
  type RemoteAuthMethod,
  type RemoteServerGenerationStatus,
  type RemoteServerSnapshot
} from "../shared.js";
import type { RemoteServerService } from "./remote.js";
import "./remote-server.css";

/**
 * 设置面板的可选宿主能力（与 sdk-agent / local-agent 同一形状）。
 *
 * 在扩展内声明而不是从核心 import：`settings.plugin-config` 的 `SettingsPanelRenderProps`
 * 住在 `cordis/plugins/settings`，不在公共 extension-api 里；扩展只按结构兼容地声明自己
 * 需要的那两项，宿主按 slot 契约传入即可。
 */
export type SettingsPanelHostProps = {
  /** 设置语境下的「返回插件列表」（经同一草稿门禁）。 */
  requestClose?: () => void;
  /** 上报 dirty/pending（宿主据此决定能否关闭或切换视图）。 */
  reportEditState?: (state: { dirty?: boolean; pending?: boolean }) => void;
};

export type RemoteServerSettingsPanelProps = {
  service: RemoteServerService;
  /**
   * 打开「服务端接入日志」窗口。
   *
   * 面板自己**不轮询、不读日志**：调试窗口是独立 dialog，只有用户点开时才拉一次并周期刷新。
   * 宿主没有 `dialogs` 能力时不传，按钮不渲染（不摆一个点了没反应的入口）。
   */
  onOpenDebug?: () => void;
} & SettingsPanelHostProps;

const METHOD_LABEL: Record<RemoteAuthMethod["kind"], string> = {
  "machine-token": "机器凭证",
  gateway: "身份网关",
  tof: "浏览器统一登录"
};

const PHASE_LABEL: Record<RemoteServerSnapshot["phase"], string> = {
  local: "本地模式",
  connecting: "正在连接",
  connected: "已连接",
  error: "连接异常"
};

export function RemoteServerSettingsPanel({
  service,
  onOpenDebug,
  reportEditState
}: RemoteServerSettingsPanelProps) {
  // 显式标注快照类型：扩展包对 React 类型是 peer/dev 依赖，`useSyncExternalStore` 的泛型
  // 推断在跨包解析时会退化成 unknown（这里推导不出 `RemoteServerService` 的返回类型）。
  const snapshot: RemoteServerSnapshot = useSyncExternalStore<RemoteServerSnapshot>(
    service.subscribe,
    service.getSnapshot,
    service.getSnapshot
  );
  /**
   * 部署配置里预置的地址（`config.local.json` / 环境变量 / 设置面）。
   *
   * 它**随快照下发**而不是由宿主当 prop 注入：宿主要读部署配置才知道这个值，而快照本来
   * 就是宿主读配置的产物。此前这个 prop 从未被任何调用方传入，于是即便部署配了
   * `serverUrl`，输入框也是空的——预置地址形同虚设，用户每次都要手打一遍。
   */
  const configuredServerUrl = snapshot.serverUrl ?? "";
  /**
   * 用户手改过的地址；`null` 表示"跟随预置值"。
   *
   * 不用 effect 把预置值推进 state：预置值要等首次 `refresh()` 回来才可见，那时用户
   * 可能已经开始输入，effect 会把他的输入覆盖掉。
   */
  const [addressDraft, setAddressDraft] = useState<string | null>(null);
  /** 已被宿主接受过的草稿（发起登录成功那一刻），此后它才是 dirty 的基线。 */
  const [acceptedDraft, setAcceptedDraft] = useState<string | null>(null);
  const address = addressDraft ?? configuredServerUrl;
  const setAddress = (value: string) => setAddressDraft(value);
  const [methods, setMethods] = useState<RemoteAuthMethod[]>([]);
  const [probeState, setProbeState] = useState<
    { kind: "idle" } | { kind: "busy" } | { kind: "ok"; version: string } | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /** 短码复制结果的短暂反馈；`idle` 时按钮显示「复制短码」。 */
  const [copyState, setCopyState] = useState<"idle" | "ok" | "error">("idle");
  /**
   * 服务端托管生成的目录状态。
   *
   * `null` 表示还没问过；连上后读一次（等于一次刷新），之后由「刷新模型」按钮更新。
   * 这里只展示数量与修订号。远端模型本身由宿主注册表注册成生成 Provider，再经
   * `GET /api/generation-models` 快照投影到设置页下方「生成的模型」区（浏览器本来就在轮询
   * 这份快照）；本面板不另外请求模型定义，刷新后约 10 秒内列表自己跟上。开关写的是普通
   * 本机模型策略，和 LiteLLM 等 Provider 走同一条路径。
   */
  const [generation, setGeneration] = useState<RemoteServerGenerationStatus | null>(null);
  const [generationBusy, setGenerationBusy] = useState(false);
  /** 进行中的设备码登录：拿到后展示短码与批准页地址，并按间隔轮询。 */
  const [deviceLogin, setDeviceLogin] = useState<{
    userCode: string;
    verificationUri: string;
    expiresAt: number;
    /** 服务端建议的轮询间隔（毫秒）。 */
    intervalMs: number;
  } | null>(null);
  /**
   * 进行中的**浏览器授权码**登录。
   *
   * 有值时面板显示「等待浏览器完成回调」并每 1.5 秒轮询一次；拿到 approved 就接上，
   * 失败/超时则显示可读文案并提供「改用短码」。
   */
  const [oauthAttempt, setOauthAttempt] = useState<{
    attemptId: string;
    authorizeUrl: string;
    expiresAt: number;
  } | null>(null);
  /**
   * 宿主明确说这条路径不可用（旧宿主没有公开回调、站内相对地址）。
   *
   * 置位后「登录并连接」直接走设备码：不再每次都先发一次注定 unsupported 的请求，也不让人
   * 为一个不存在的入口多等一次往返。
   */
  const [oauthUnsupported, setOauthUnsupported] = useState(false);
  /** 浏览器登录失败/超时：在错误文案旁给出「改用短码」入口。 */
  const [oauthFallback, setOauthFallback] = useState(false);

  // 挂载即读一次权威状态：徽标可能已经读过，共享 service 会复用同一次请求。
  useEffect(() => {
    void service.refresh();
  }, [service]);

  /**
   * 草稿基线：预置值或「已被宿主接受过的地址」。
   *
   * dirty = 地址与基线不同；pending = 探测/登录/断开请求在途。两者都必须在**渲染后**上报
   * （不在渲染阶段写外部状态），因此走 effect。
   *
   * 基线不用 state：它就是另外两个值的纯推导，存一份会多出一个需要同步的副本。
   */
  const baselineAddress = acceptedDraft ?? configuredServerUrl;
  const addressDirty = address.trim() !== baselineAddress.trim();
  useEffect(() => {
    const state = { dirty: addressDirty, pending };
    reportEditState?.(state);
  }, [reportEditState, addressDirty, pending]);
  // 卸载时清掉自己的上报，避免把 dirty 留在已关闭的面板上。
  const reportRef = useRef(reportEditState);
  reportRef.current = reportEditState;
  useEffect(() => () => reportRef.current?.({ dirty: false, pending: false }), []);

  const probe = useCallback(async () => {
    setProbeState({ kind: "busy" });
    const result = await service.api.probe({ ...(address.trim() ? { serverUrl: address.trim() } : {}) });
    if (!result.ok) {
      setProbeState({ kind: "error", message: result.error });
      setMethods([]);
      return;
    }
    setMethods(result.methods);
    setProbeState({ kind: "ok", version: result.commit ? `${result.version} (${result.commit})` : result.version });
  }, [service, address]);

  /** 浏览器与本机宿主是否同机：只有这时浏览器授权码登录才可达（回调要落到本机 loopback）。 */
  const loopback = typeof window !== "undefined" && isLoopbackHostname(window.location.hostname);

  /**
   * 发起设备码登录（兜底路径）。
   *
   * 这里**不收集任何凭据**：登录发生在服务端的登录页上。客户端只做两件事——把短码与
   * 地址摆到人面前，然后轮询。人在那个页面上已是登录态，批准后客户端自动接上。
   */
  const connectWithDeviceCode = useCallback(async () => {
    setPending(true);
    setActionError(null);
    setOauthFallback(false);
    const result = await service.api.startDeviceLogin({
      ...(address.trim() ? { serverUrl: address.trim() } : {})
    });
    setPending(false);
    if (!result.ok) {
      setActionError(result.error);
      return;
    }
    // 地址已被宿主接受：它是新的权威值，后续编辑从这个基线算 dirty。
    setAcceptedDraft(address.trim());
    setDeviceLogin({
      userCode: result.start.userCode,
      verificationUri: result.start.verificationUri,
      expiresAt: result.start.expiresAt,
      // 轮询间隔由服务端给（change 任务 6.4）：在客户端写死会让改服务端参数失效。
      intervalMs: result.start.intervalMs
    });
    // 在新标签页打开批准页：用户在那里登录并输入短码。
    if (typeof window !== "undefined") {
      window.open(result.start.verificationUri, "_blank", "noopener,noreferrer");
    }
  }, [service, address]);

  /**
   * 「登录并连接」：同机时默认走**浏览器授权码登录**（design D6）。
   *
   * 一步完成：打开服务端授权入口 → 企业统一登录（有 SSO 会话时免输入）→ 服务端 302 回宿主
   * 的 loopback 回调 → 宿主换码并落会话 → 这里轮询到 approved 就接上。人不需要抄短码，也不需要
   * 点批准。
   *
   * 宿主说这条路径不存在（旧版本没有公开回调 / 站内相对地址）或这一次没发起成功时**直接**改走
   * 设备码：设备码自己的错误信息也更贴近人下一步该做什么。
   */
  const connect = useCallback(async () => {
    if (!loopback || oauthUnsupported) {
      await connectWithDeviceCode();
      return;
    }
    setPending(true);
    setActionError(null);
    setOauthFallback(false);
    const started = await service.api.startOauthLogin({ origin: window.location.origin });
    setPending(false);
    if (!started.ok) {
      if (started.unsupported) setOauthUnsupported(true);
      await connectWithDeviceCode();
      return;
    }
    // 地址已被宿主接受：它是新的权威值，后续编辑从这个基线算 dirty。
    setAcceptedDraft(address.trim());
    setOauthAttempt({
      attemptId: started.attemptId,
      authorizeUrl: started.authorizeUrl,
      expiresAt: started.expiresAt
    });
    // 在新标签页打开授权入口：人在那里完成企业统一登录，服务端随后回调本机宿主。
    window.open(started.authorizeUrl, "_blank", "noopener,noreferrer");
  }, [loopback, oauthUnsupported, connectWithDeviceCode, service, address]);

  // 轮询设备码登录状态。只在有进行中的登录时存在，结束即清掉定时器。
  useEffect(() => {
    if (!deviceLogin) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // 间隔取服务端给的值（缺省 5 秒，与只发一次就打死不让改的写死值不同）。
    const intervalMs = Math.max(1000, deviceLogin.intervalMs);
    const tick = async () => {
      if (cancelled) return;
      // 到期即停：否则界面会永远转圈，人不知道是该再等还是重新发起。
      if (Date.now() >= deviceLogin.expiresAt) {
        setDeviceLogin(null);
        setActionError("这次登录已过期，请重新发起");
        return;
      }
      const result = await service.api.pollDeviceLogin();
      if (cancelled) return;
      if (result.state === "approved") {
        service.setSnapshot(result.snapshot);
        setDeviceLogin(null);
        return;
      }
      if (result.state === "denied") {
        setDeviceLogin(null);
        setActionError("已在该页面上拒绝本次登录");
        return;
      }
      if (result.state === "expired") {
        setDeviceLogin(null);
        setActionError("登录请求已过期，请重新发起");
        return;
      }
      timer = setTimeout(() => void tick(), intervalMs);
    };
    timer = setTimeout(() => void tick(), intervalMs);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [deviceLogin, service]);

  // 轮询浏览器登录：每 1.5 秒问一次宿主「回调到了吗」，最长等 5 分钟。
  useEffect(() => {
    if (!oauthAttempt) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // 两个上限取更早的那个：宿主给的尝试到期时刻，与「这条路的合理等待时长」。
    const deadline = Math.min(oauthAttempt.expiresAt, Date.now() + REMOTE_SERVER_OAUTH_POLL_TIMEOUT_MS);
    const tick = async () => {
      if (cancelled) return;
      if (Date.now() >= deadline) {
        setOauthAttempt(null);
        setOauthFallback(true);
        setActionError("浏览器登录等待超时，可以改用短码继续");
        return;
      }
      const result = await service.api.pollOauthLogin(oauthAttempt.attemptId);
      if (cancelled) return;
      if (result.state === "approved") {
        // 宿主已经落好会话：本地推进状态，作废任何在途的旧快照。
        service.setSnapshot(result.snapshot);
        setOauthAttempt(null);
        return;
      }
      if (result.state === "failed") {
        setOauthAttempt(null);
        setOauthFallback(true);
        setActionError(result.error);
        return;
      }
      timer = setTimeout(() => void tick(), REMOTE_SERVER_OAUTH_POLL_INTERVAL_MS);
    };
    timer = setTimeout(() => void tick(), REMOTE_SERVER_OAUTH_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [oauthAttempt, service]);

  const disconnect = useCallback(async () => {
    setPending(true);
    setActionError(null);
    const result = await service.api.logout();
    setPending(false);
    if (!result.ok) setActionError(result.error);
    const next = await service.refresh();
    // 断开后回到「本地模式」：这是正常选择，不是失败。
    if (next.phase !== "local" && next.phase !== "error") {
      service.setSnapshot({ ...next, phase: "local", subject: null, displayName: null, expiresAt: null, error: null });
    }
  }, [service]);

  /** 读一次托管生成目录状态（等同一次刷新）；失败也落在可展示的稳定短语上。 */
  const loadGenerationModels = useCallback(async () => {
    setGenerationBusy(true);
    const result = await service.api.refreshGenerationModels();
    setGenerationBusy(false);
    setGeneration(
      result.ok
        ? result.status
        : { available: false, modelCount: 0, catalogRevision: 0, error: result.error }
    );
  }, [service]);

  const connected = snapshot.phase === "connected";

  // 连上后读一次目录状态：模型数量是「服务端提供了什么」的唯一常驻表达。
  useEffect(() => {
    if (!connected) return;
    void loadGenerationModels();
  }, [connected, loadGenerationModels]);

  /**
   * 把短码复制到剪贴板。
   *
   * **只复制，不改批准页地址**：短码进 URL 会让人跳过「页面上这次请求是不是我刚发起的
   * 那一次」的核对（见本文件设备码段落里的注释与 design D2）。复制只省一次手抄，人仍然
   * 要在那个页面上看清「正在以谁的身份批准」。
   *
   * 剪贴板不可用（非安全上下文、权限被拒）时给可见失败，不静默——静默会让人粘贴出一个
   * 上次复制的旧短码，然后得到一条「无效」的答复。
   */
  const copyCode = useCallback(async () => {
    if (!deviceLogin) return;
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard) throw new Error("当前环境不支持剪贴板");
      await navigator.clipboard.writeText(deviceLogin.userCode);
      setCopyState("ok");
    } catch {
      setCopyState("error");
    }
  }, [deviceLogin]);

  // 复制反馈两秒后复原，避免按钮一直停在「已复制」而看不出还能再按。
  useEffect(() => {
    if (copyState === "idle") return;
    const timer = setTimeout(() => setCopyState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [copyState]);

  return (
    <div data-testid="remote-server-settings">
      <SettingsSection
        title="服务端接入"
        description="接入远端 woohaa-server 后，画布会同时同步到远端；不接入时应用完全在本机运行。"
        action={
          onOpenDebug ? (
            <Button size="sm" tone="ghost" onClick={onOpenDebug} data-testid="server-open-debug">
              服务端日志
            </Button>
          ) : undefined
        }
      >
        <div className="remote-server-status" data-testid="server-status" data-phase={snapshot.phase}>
          <span className={`remote-server-status__dot is-${snapshot.phase}`} aria-hidden="true" />
          <div>
            <strong>{PHASE_LABEL[snapshot.phase]}</strong>
            <p>
              {snapshot.phase === "local"
                ? "当前只在本地保存，不会向任何远端发送内容。"
                : snapshot.phase === "connected"
                  ? `${snapshot.serverUrl ?? ""}${snapshot.subject ? ` · ${snapshot.displayName ?? snapshot.subject}` : ""}`
                  : (snapshot.error ?? actionError ?? "连接失败")}
            </p>
          </div>
        </div>

        {connected ? (
          <>
            <dl className="remote-server-facts">
              <dt>地址</dt>
              <dd>{snapshot.serverUrl}</dd>
              <dt>主体</dt>
              <dd>{snapshot.displayName ?? snapshot.subject}</dd>
              <dt>会话到期</dt>
              <dd>{snapshot.expiresAt ? new Date(snapshot.expiresAt).toLocaleString() : "未知"}</dd>
              <dt>服务端模型</dt>
              <dd data-testid="server-generation-models">
                {generation === null
                  ? "读取中…"
                  : generation.available
                    ? `${generation.modelCount} 个`
                    : "暂未提供"}
              </dd>
            </dl>
            <p className="settings-section__hint">
              托管生成由服务端发现：数量在这里，具体模型列在下方「生成的模型」里，按需启用后才会
              进入模型选择器。服务端尚未提供时保持本地正常态。
            </p>
            {generation?.error ? (
              // 休眠/暂不可达是正常状态的说明，不冒充故障：用提示行而不是 danger 反馈。
              <p className="settings-section__hint" data-testid="server-generation-reason">
                {generation.error}
              </p>
            ) : null}
            <div className="settings-section__actions settings-section__actions--end">
              <Button
                size="sm"
                tone="ghost"
                disabled={generationBusy}
                onClick={() => void loadGenerationModels()}
                data-testid="server-refresh-models"
              >
                {generationBusy ? "刷新中…" : "刷新模型"}
              </Button>
              <Button size="sm" tone="ghost" disabled={pending} onClick={() => void disconnect()} data-testid="server-disconnect">
                {pending ? "断开中…" : "断开连接"}
              </Button>
            </div>
          </>
        ) : (
          <div className="settings-section__fields">
            <label className="settings-section__field">
              <span>服务端地址</span>
              <TextInput
                type="text"
                value={address}
                placeholder="https://woohaa.example.com"
                spellCheck={false}
                onChange={(event) => setAddress(event.target.value)}
                data-testid="server-address"
              />
            </label>
            {configuredServerUrl !== "" && !addressDirty ? (
              // 说明这个值是部署预置的、不是用户自己敲的：否则人会以为它来路不明，
              // 或者误以为需要先"保存"一次才能用。
              <p className="settings-section__hint" data-testid="server-address-preset">
                地址由部署预置，直接点「登录并连接」即可；需要换一台就改上面这个输入框。
              </p>
            ) : null}
            <div className="settings-section__actions">
              <Button size="sm" tone="ghost" disabled={probeState.kind === "busy"} onClick={() => void probe()} data-testid="server-probe">
                {probeState.kind === "busy" ? "探测中…" : "测试连接"}
              </Button>
              {probeState.kind === "ok" ? (
                <span className="remote-server-ok">可达 · {probeState.version || "版本未知"}</span>
              ) : null}
            </div>
            {probeState.kind === "error" ? (
              <SettingsFeedback tone="danger">{probeState.message}</SettingsFeedback>
            ) : null}

            {methods.length > 0 ? (
              <p className="settings-section__hint">
                该部署提供：{methods.map((method) => METHOD_LABEL[method.kind]).join("、")}
                {methods.some((method) => method.kind === "gateway" && method.ambient)
                  ? "。检测到当前请求已带网关身份，可直接连接。"
                  : ""}
              </p>
            ) : null}

            {deviceLogin ? (
              <div className="remote-server-device" data-testid="server-device-code">
                <p className="settings-section__hint">
                  已在服务端打开登录页。若没有自动打开，请访问
                  <a href={deviceLogin.verificationUri} target="_blank" rel="noreferrer">
                    {deviceLogin.verificationUri}
                  </a>
                  ，登录后输入下面的短码：
                </p>
                <div className="remote-server-device__row">
                  <code className="remote-server-device__code">{deviceLogin.userCode}</code>
                  <Button size="sm" tone="ghost" onClick={() => void copyCode()} data-testid="server-device-copy">
                    {copyState === "ok" ? "已复制" : "复制短码"}
                  </Button>
                </div>
                <p className="settings-section__hint">
                  正在等待批准…这个短码 15 分钟内有效。
                  {/*
                    短码**不**进批准页地址（见 change 2026-10-19-add-remote-server-device-login
                    design D2）：嵌进链接会让人直接点开、跳过「页面上这次请求是不是我刚刚发起
                    的那一次」的核对，而那正是挡住「受害者把客户端登进攻击者账号」的唯一防线。
                    所以这里只给"复制"，不给"一键打开并填好"。
                  */}
                  复制后到那个页面上粘贴到「短码」输入框，确认页面显示的账号是你自己再批准。
                </p>
              </div>
            ) : oauthAttempt ? (
              // 浏览器登录进行中：回调由服务端 302 到本机宿主，这里只等结果。
              <div className="remote-server-oauth" data-testid="server-oauth-pending">
                <p className="settings-section__hint">
                  已在浏览器打开企业统一登录页；完成登录后会自动接上，这里不需要再操作。
                </p>
                <p className="settings-section__hint">
                  若没有自动打开，请
                  <a href={oauthAttempt.authorizeUrl} target="_blank" rel="noreferrer">
                    点这里打开登录页
                  </a>
                  。正在等待浏览器完成登录…（最长等待 5 分钟）
                </p>
                <div className="settings-section__actions">
                  <Button
                    size="sm"
                    tone="ghost"
                    onClick={() => {
                      // 用户主动放弃浏览器登录：停轮询并立刻走短码，不让他再等 5 分钟。
                      setOauthAttempt(null);
                      setOauthFallback(true);
                      void connectWithDeviceCode();
                    }}
                    data-testid="server-oauth-fallback"
                  >
                    改用短码
                  </Button>
                </div>
              </div>
            ) : (
              <>
                {actionError ? (
                  <SettingsFeedback tone="danger">
                    <span role="alert">{actionError}</span>
                  </SettingsFeedback>
                ) : null}
                <div className="settings-section__actions">
                  <Button size="sm" disabled={pending} onClick={() => void connect()} data-testid="server-connect">
                    {pending ? "正在发起…" : "登录并连接"}
                  </Button>
                  {oauthFallback ? (
                    // 浏览器登录失败/超时：把设备码摆到下一步，人不需要再回设置里找一遍。
                    <Button
                      size="sm"
                      tone="ghost"
                      disabled={pending}
                      onClick={() => void connectWithDeviceCode()}
                      data-testid="server-oauth-fallback"
                    >
                      改用短码
                    </Button>
                  ) : null}
                </div>
                <p className="settings-section__hint">
                  {loopback && !oauthUnsupported
                    ? "登录发生在服务端：点击后会打开企业统一登录页，登录完成即自动连接，不需要抄短码。"
                    : "登录发生在服务端：这里不会要求你输入任何凭据。点击后会打开服务端的登录页，用你的账号批准一次，连接随即建立。"}
                </p>
              </>
            )}
          </div>
        )}
      </SettingsSection>
    </div>
  );
}
