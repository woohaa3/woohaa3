/** 打开设置即检测工具与服务，启用动作不要求用户创建或命名连接。 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@woohaa3/ui/primitives";
import { RefreshIcon, ServiceLogo } from "@woohaa3/ui/icons";
import { SettingsSection, SettingsFeedback } from "@woohaa3/ui/settings";
import type {
  LocalAgentAdapterView,
  LocalAgentConnectionView,
  LocalAgentRemote,
} from "./remote.js";

export type SettingsPanelHostProps = {
  /** 设置语境下的「返回插件列表」（经同一草稿门禁）。 */
  requestClose?: () => void;
  /** 上报 dirty/pending（宿主据此决定能否关闭或切换视图）。 */
  reportEditState?: (state: { dirty?: boolean; pending?: boolean }) => void;
};

export function LocalAgentSettingsPanel({
  remote, connectionId, onSaved, reportEditState, onOpenRuntimes,
}: {
  remote: LocalAgentRemote;
  connectionId?: string;
  onSaved?: (connectionId: string) => void;
  onOpenRuntimes?: () => void;
} & SettingsPanelHostProps) {
  const [adapters, setAdapters] = useState<LocalAgentAdapterView[]>([]);
  const [connections, setConnections] = useState<LocalAgentConnectionView[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const [removing, setRemoving] = useState<string | null>(null);
  // 本机面板没有草稿输入（动作即时提交）；只把进行中的检测/启用/删除上报为 pending。
  useEffect(() => {
    reportEditState?.({ dirty: false, pending: Boolean(busy) || loading });
  }, [reportEditState, busy, loading]);
  const inFlight = useRef(false);
  const requestId = useRef(0);
  const operation = useRef(false);
  const refresh = async (force = false) => {
    if (inFlight.current && !force) return;
    inFlight.current = true;
    const id = ++requestId.current;
    try {
      const result = await remote.list();
      if (id !== requestId.current) return;
      if (!result.ok) {
        setNotice({ text: result.error, error: true });
        return;
      }
      setAdapters(result.value.adapters);
      setConnections(result.value.connections);
    } catch {
      if (id === requestId.current)
        setNotice({ text: "检测未完成，请检查后端连接后重试。", error: true });
    } finally {
      if (id === requestId.current) {
        inFlight.current = false;
        setLoading(false);
      }
    }
  };
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 10000);
    return () => {
      clearInterval(timer);
      requestId.current++;
      inFlight.current = false;
    };
  }, [remote]);
  const perform = async (id: string, run: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(id);
    setNotice(null);
    try {
      await run();
    } catch {
      setNotice({ text: "请求未完成，请重试。", error: true });
    } finally {
      operation.current = false;
      setBusy(null);
    }
  };
  return (
    <div data-testid="local-agent-settings">
      <SettingsSection
        title="连接本地 agent"
        action={
          <Button
            size="sm"
            icon={<RefreshIcon size={14} />}
            loading={loading}
            disabled={Boolean(busy)}
            onClick={() => {
              setLoading(true);
              setNotice(null);
              void refresh(true);
            }}
          >
            重新检测
          </Button>
        }
      >
        {loading && adapters.length === 0 ? (
          <p className="settings-section__hint">正在检测本机工具…</p>
        ) : null}
        {connectionId && !loading && !connections.some((entry) => entry.connectionId === connectionId) ? <SettingsFeedback tone="warning">此助手已停用，请返回列表重新选择。</SettingsFeedback> : null}
        <ul className="settings-section__list">
          {adapters.filter((adapter) => !connectionId || connections.some((entry) => entry.connectionId === connectionId && entry.adapterId === adapter.adapterId)).map((adapter) => {
            const connection = connections.find(
              (entry) => entry.adapterId === adapter.adapterId,
            );
            const installed =
              adapter.installed ?? connection?.executableInstalled ?? false;
            const running = adapter.running ?? connection?.running ?? false;
            return (
              <li key={adapter.adapterId} data-adapter-id={adapter.adapterId}>
                <div className="settings-section__item">
                  <div className="settings-section__item-main">
                    <strong><span className="service-identity"><ServiceLogo service={adapter.adapterId === "codex-appserver" ? "chatgpt" : adapter.adapterId} />{adapter.label}</span></strong>
                    <p className="settings-section__hint">{installed ? `已安装 · ${running ? "运行中" : "未运行"}` : running ? "未安装 · 发现其他服务进程" : "尚未安装"}</p>
                    {!installed ? <p className="settings-section__hint">{adapter.adapterId === "codex-appserver" ? "本地 ChatGPT 通过 Codex 连接。请安装或选择 Codex 程序。" : "请先在运行本应用的电脑上安装对应命令行工具。"}</p> : null}
                  </div>
                  {connection ? (
                    <>
                      <Button
                        size="sm"
                        tone="ghost"
                        disabled={Boolean(busy)}
                        onClick={() => setRemoving(connection.connectionId)}
                      >
                        停用
                      </Button>
                    </>
                  ) : !installed ? (
                    adapter.adapterId === "codex-appserver" && onOpenRuntimes ? (
                      <Button size="sm" disabled={Boolean(busy)} onClick={onOpenRuntimes}>安装或选择 Codex</Button>
                    ) : (
                      <a className="settings-section__hint" href={adapter.adapterId === "opencode-server" ? "https://opencode.ai/docs/" : adapter.adapterId === "codebuddy-server" ? "https://www.codebuddy.cn/docs/cli/installation" : "https://developers.openai.com/codex/cli/"} target="_blank" rel="noreferrer">查看安装说明 ↗</a>
                    )
                  ) : (
                    <Button
                      size="sm"
                      disabled={Boolean(busy) || !installed}
                      loading={busy === adapter.adapterId}
                      onClick={() =>
                        void perform(adapter.adapterId, async () => {
                          const result = await remote.create({
                            adapterId: adapter.adapterId,
                            useDetected: true,
                          });
                          if (!result.ok) {
                            setNotice({ text: result.error, error: true });
                            return;
                          }
                          await refresh(true);
                          onSaved?.(result.value.connectionId);
                          setNotice({
                            text: "已启用",
                            error: false,
                          });
                        })
                      }
                    >
                      使用此工具
                    </Button>
                  )}
                </div>
                {connection && removing === connection.connectionId ? (
                  <SettingsFeedback tone="warning">
                    <p>停用“{connection.name}”？历史与画布结果会保留。</p>
                    <div className="settings-section__actions">
                      <Button
                        onClick={() => setRemoving(null)}
                        disabled={Boolean(busy)}
                      >
                        取消
                      </Button>
                      <Button
                        tone="danger"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void perform(connection.connectionId, async () => {
                            const result = await remote.remove(
                              connection.connectionId,
                            );
                            if (!result.ok) {
                              setNotice({ text: result.error, error: true });
                              return;
                            }
                            setRemoving(null);
                            await refresh(true);
                            if (connectionId) onSaved?.("");
                          })
                        }
                      >
                        确认停用
                      </Button>
                    </div>
                  </SettingsFeedback>
                ) : null}
              </li>
            );
          })}
        </ul>
        {adapters.some(adapter => adapter.installed === false) ? <p className="settings-section__hint">安装并登录后，点击“重新检测”，再选择“使用此工具”。</p> : <p className="settings-section__hint">选择“使用此工具”后会添加到助手列表；执行任务时由应用自动启动。</p>}
        {notice ? (
          <div data-testid="local-agent-notice">
            <SettingsFeedback tone={notice.error ? "danger" : "success"}>
              {notice.text}
            </SettingsFeedback>
          </div>
        ) : null}
      </SettingsSection>
    </div>
  );
}
