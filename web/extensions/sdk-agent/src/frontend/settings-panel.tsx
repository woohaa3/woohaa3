/** 模型 API 设置：填写地址和 Key 后一次保存，连接身份由后端管理。 */
import { useEffect, useRef, useState } from "react";
import { isAgentConnectionStatus } from "@woohaa3/contracts";
import {
  Button,
  TextInput,
  SelectInput,
  Collapsible,
  ChevronDownIcon,
  SettingsSection,
  SettingsFeedback,
  ServiceLogo,
} from "@woohaa3/frontend/extension-api";
import type {
  SdkAgentAdapterView,
  SdkAgentConnectionView,
  SdkAgentRemote,
} from "./remote.js";

function configurationError(error: string) {
  return error === "请求失败" ? "请求失败，请检查服务地址与后端连接后重试。" : error;
}

type Notice = { text: string; tone: "success" | "danger" | "warning" };

/**
 * 设置面板的可选宿主能力（change: 2026-10-17-move-settings-into-canvas-dialog）：
 * 宿主把面板的未保存输入与进行中请求汇总进设置的退出保护。独立渲染时缺省不启用。
 */
export type SettingsPanelHostProps = {
  /** 设置语境下的「返回插件列表」（经同一草稿门禁）。 */
  requestClose?: () => void;
  /** 上报 dirty/pending（宿主据此决定能否关闭或切换视图）。 */
  reportEditState?: (state: { dirty?: boolean; pending?: boolean }) => void;
};

export function SdkAgentSettingsPanel({
  remote,
  connectionId,
  onSaved,
  reportEditState,
  onOpenRuntimes,
}: {
  onOpenRuntimes?: () => void;
  remote: SdkAgentRemote;
  connectionId?: string;
  onSaved?: (connectionId: string) => void;
} & SettingsPanelHostProps) {
  const [services, setServices] = useState<SdkAgentConnectionView[]>([]);
  const [adapters, setAdapters] = useState<SdkAgentAdapterView[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [adapterId, setAdapterId] = useState("compat-chat");
  const [baseUrl, setBaseUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [modelsText, setModelsText] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"clear" | "remove" | null>(null);
  const operation = useRef(false);
  const listRequest = useRef(0);
  const current = services.find((entry) => entry.connectionId === editing);
  const adapter = adapters.find((entry) => entry.adapterId === adapterId);
  const sameEndpoint = Boolean(
    current &&
      current.adapterId === adapterId &&
      (baseUrl.trim().replace(/\/+$/, "") || adapter?.officialBaseUrl) ===
        (current.baseUrl?.replace(/\/+$/, "") || adapter?.officialBaseUrl),
  );
  const canKeepKey = sameEndpoint && current?.credentialConfigured;
  const previousStatus = isAgentConnectionStatus(current?.lastStatus)
    ? current.lastStatus
    : null;
  const [testModel, setTestModel] = useState("");
  const [savedWithoutModels, setSavedWithoutModels] = useState<string | null>(null);

  // dirty：地址与基线不同，或 Key / 手填模型有未保存输入；pending：写/测试请求进行中。
  // 基线只在「载入/保存成功」时重设，避免编辑过程中因列表刷新而误判为干净。
  const [baseline, setBaseline] = useState({ baseUrl: "", modelsText: "" });
  const dirty =
    baseUrl.trim() !== baseline.baseUrl.trim() ||
    modelsText.trim() !== baseline.modelsText.trim() ||
    secret.trim() !== "";
  useEffect(() => {
    reportEditState?.({ dirty, pending: Boolean(busy) });
  }, [reportEditState, dirty, busy]);

  const refresh = async (savedServiceId?: string) => {
    const id = ++listRequest.current;
    try {
      const result = await remote.list();
      if (id !== listRequest.current) return false;
      if (!result.ok) {
        setNotice({ tone: "danger", text: configurationError(result.error) });
        return false;
      }
      setServices(result.value.connections);
      setAdapters(result.value.adapters);
      if (savedServiceId) {
        const saved = result.value.connections.find(
          (entry) => entry.connectionId === savedServiceId,
        );
        if (saved) {
          const savedUrl =
            saved.baseUrl ??
            result.value.adapters.find(
              (entry) => entry.adapterId === saved.adapterId,
            )?.officialBaseUrl ??
            "";
          setBaseUrl(savedUrl);
          // 保存成功后的权威值即新基线：地址被宿主规范化时也不会误判为 dirty。
          setBaseline({ baseUrl: savedUrl, modelsText });
        }
      }
      return true;
    } catch {
      if (id === listRequest.current)
        setNotice({ tone: "danger", text: "无法读取服务设置，请重试。" });
      return false;
    } finally {
      if (id === listRequest.current) setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
    return () => {
      listRequest.current++;
    };
  }, [remote]);
  useEffect(() => {
    if (connectionId && services.some((entry) => entry.connectionId === connectionId) && editing !== connectionId) reset(services.find((entry) => entry.connectionId === connectionId));
  }, [connectionId, services]);
  const reset = (entry?: SdkAgentConnectionView) => {
    setSavedWithoutModels(null);
    setEditing(entry?.connectionId ?? null);
    setAdapterId(entry?.adapterId ?? "compat-chat");
    setBaseUrl(
      entry?.baseUrl ??
        adapters.find((item) => item.adapterId === entry?.adapterId)
          ?.officialBaseUrl ??
        "",
    );
    setSecret("");
    setModelsText("");
    setTestModel("");
    setBaseline({
      baseUrl:
        entry?.baseUrl ??
        adapters.find((item) => item.adapterId === entry?.adapterId)
          ?.officialBaseUrl ??
        "",
      modelsText: "",
    });
    setNotice(null);
    setConfirm(null);
    setAdvanced(false);
  };
  const perform = async (action: string, run: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(action);
    setNotice(null);
    try {
      await run();
    } catch {
      setNotice({ tone: "danger", text: "请求未完成，请检查后端连接后重试。" });
    } finally {
      operation.current = false;
      setBusy(null);
    }
  };
  const save = () =>
    perform("save", async () => {
      const models = modelsText
        .split(/[,，\n]/)
        .map((value) => value.trim())
        .filter(Boolean);
      const result = await remote.configure({
        adapterId,
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(secret.trim() ? { secret: secret.trim() } : {}),
        ...(models.length ? { models } : {}),
        ...(current
          ? {
              connectionId: current.connectionId,
              expectedEpoch: current.credentialEpoch,
              expectedRevision: current.configRevision,
            }
          : {}),
      });
      if (!result.ok) {
        await refresh();
        setNotice({ tone: "danger", text: configurationError(result.error) });
        return;
      }
      setSecret("");
      setEditing(result.value.connectionId);
      if (!(await refresh(result.value.connectionId))) {
        setNotice({
          tone: "warning",
          text: "设置已保存，列表刷新失败，请重新加载。",
        });
        return;
      }
      if (result.value.modelsError) {
        setSavedWithoutModels(result.value.connectionId);
        setAdvanced(true);
        setNotice({
          tone: "warning",
          text: `地址和 Key 已保存。${result.value.modelsError}`,
        });
      } else
        setNotice({
          tone: "success",
          text: "已保存",
        });
      if (!result.value.modelsError) onSaved?.(result.value.connectionId);
    });
  const destroy = () =>
    perform(confirm!, async () => {
      if (!current) return;
      const result =
        confirm === "clear"
          ? await remote.clearCredential(current.connectionId)
          : await remote.remove(current.connectionId);
      if (!result.ok) {
        setNotice({ tone: "danger", text: configurationError(result.error) });
        return;
      }
      const removed = confirm === "remove";
      reset();
      await refresh();
      if (removed) onSaved?.("");
      setNotice({
        tone: "success",
        text:
          confirm === "clear"
            ? "Key 已清除。"
            : "服务已移除，历史与画布结果已保留。",
      });
    });

  if (connectionId && !loading && !services.some((entry) => entry.connectionId === connectionId)) return <SettingsFeedback tone="warning">此助手已不存在，请返回列表重新选择。</SettingsFeedback>;

  return (
    <div data-testid="sdk-agent-settings">
      <SettingsSection
        title="模型 API"
      >
        <form
          className="settings-section__fields"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="settings-section__field">
            <span>API 协议</span>
            <SelectInput
              label="API 协议"
              value={adapterId}
              disabled={Boolean(busy) || loading}
              onValueChange={(value) => {
                setAdapterId(value);
                setBaseUrl("");
                setSecret("");
                setModelsText("");
                setConfirm(null);
                setNotice(null);
              }}
              options={adapters.filter((entry) => entry.adapterId === adapterId || !["codex-agent-sdk", "claude-agent-sdk"].includes(entry.adapterId)).map((entry) => ({
                value: entry.adapterId,
                label: entry.label,
              }))}
            />
          </div>
          {adapter?.allowCustomBaseUrl ? <label className="settings-section__field">
            <span>Base URL</span>
            <TextInput
              aria-label="Base URL"
              type="url"
              value={baseUrl}
              placeholder={
                adapter?.officialBaseUrl ?? "https://api.openai.com/v1"
              }
              disabled={
                Boolean(busy) || loading || !adapter?.allowCustomBaseUrl
              }
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </label> : null}
          <label className="settings-section__field">
            <span>API Key</span>
            <TextInput
              aria-label="API Key"
              type="password"
              autoComplete="off"
              value={secret}
              placeholder={
                canKeepKey
                  ? "已保存；留空保留，填写则替换"
                  : "粘贴服务提供的 API Key"
              }
              disabled={Boolean(busy) || loading}
              onChange={(event) => setSecret(event.target.value)}
            />
          </label>
          <Collapsible
            open={advanced}
            onOpenChange={setAdvanced}
            trigger={
              <>
                <ChevronDownIcon size={14} />
                手动指定模型（可选）
              </>
            }
          >
            <label className="settings-section__field">
              <span>模型 ID</span>
              <TextInput
                aria-label="模型 ID"
                value={modelsText}
                disabled={Boolean(busy)}
                onChange={(event) => setModelsText(event.target.value)}
                placeholder={
                  current?.models.join(", ") ||
                  "服务不提供模型列表时填写，多个用逗号分隔"
                }
              />
            </label>
          </Collapsible>
          <div className="settings-section__actions settings-section__actions--end">
            {editing && !onSaved ? (
              <Button
                disabled={Boolean(busy)}
                tone="ghost"
                onClick={() => reset()}
              >
                配置其他服务
              </Button>
            ) : null}
            <Button
              type="submit"
              tone="primary"
              loading={busy === "save"}
              disabled={
                Boolean(busy) ||
                loading ||
                !adapter ||
                (!secret.trim() && !canKeepKey)
              }
            >
              保存并读取模型
            </Button>
          </div>
        </form>
        {onOpenRuntimes ? <SettingsFeedback tone="warning">
          Codex、Claude 等引擎需要运行时组件。首次使用前，可下载组件或选择本机程序。
          <Button size="sm" onClick={onOpenRuntimes}>管理运行时组件</Button>
        </SettingsFeedback> : null}
        {notice ? (
          <div data-testid="sdk-agent-notice">
            <SettingsFeedback tone={notice.tone}>
              {notice.text}
            </SettingsFeedback>
          </div>
        ) : null}
        {savedWithoutModels && onSaved && !secret.trim() && sameEndpoint && !modelsText.trim() ? <div className="settings-section__actions settings-section__actions--end"><Button onClick={() => onSaved(savedWithoutModels)}>稍后选择模型</Button></div> : null}
        {!loading && adapters.length === 0 ? (
          <Button onClick={() => void refresh()}>重新加载</Button>
        ) : null}
        {!onSaved && services.length > 0 ? (
          <ul className="settings-section__list settings-section__divider">
            {services.map((entry) => (
              <li
                key={entry.connectionId}
                data-connection-id={entry.connectionId}
              >
                <div className="settings-section__item">
                  <div className="settings-section__item-main">
                    <strong><span className="service-identity"><ServiceLogo service={entry.adapterId} />{entry.name}</span></strong>
                    <p className="settings-section__hint">
                      {entry.baseUrl || entry.label}
                    </p>
                  </div>
                  <span
                    className="settings-section__badge"
                    data-ready={entry.credentialConfigured}
                  >
                    {entry.credentialConfigured ? "Key 已保存" : "待填写 Key"}
                  </span>
                  <Button
                    size="sm"
                    tone="ghost"
                    disabled={Boolean(busy)}
                    onClick={() => reset(entry)}
                  >
                    {editing === entry.connectionId ? "正在编辑" : "编辑"}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {current ? (
          <>
            <Collapsible
              trigger={
                <>
                  <ChevronDownIcon size={14} />
                  测试与维护
                </>
              }
            >
              <div className="settings-section__fields">
                {!adapter?.allowCustomBaseUrl && adapter?.officialBaseUrl ? <p className="settings-section__hint">服务地址：{current.baseUrl || adapter.officialBaseUrl}</p> : null}
                <div className="settings-section__field">
                  <span>测试模型</span>
                  <SelectInput
                    label="测试模型"
                    value={testModel}
                    disabled={Boolean(busy)}
                    onValueChange={setTestModel}
                    options={[
                      { value: "", label: "默认模型" },
                      ...current.models.map((id) => ({ value: id, label: id })),
                    ]}
                  />
                </div>
                <div className="settings-section__actions">
                  <Button
                    disabled={
                      Boolean(busy) ||
                      !current.credentialConfigured ||
                      current.needsLocalRuntime
                    }
                    loading={busy === "test"}
                    onClick={() =>
                      void perform("test", async () => {
                        const result = await remote.testGeneration({
                          connectionId: current.connectionId,
                          ...(testModel ? { model: testModel } : {}),
                        });
                        setNotice(
                          !result.ok
                            ? { tone: "danger", text: configurationError(result.error) }
                            : result.value.ok
                              ? {
                                  tone: "success",
                                  text: `${result.value.model} 测试成功。`,
                                }
                              : {
                                  tone: "danger",
                                  text:
                                    result.value.message ||
                                    "测试失败，请检查 Key 与模型权限。",
                                },
                        );
                        await refresh();
                      })
                    }
                  >
                    测试生成
                  </Button>
                  <Button
                    tone="ghost"
                    disabled={Boolean(busy) || !current.credentialConfigured}
                    onClick={() => setConfirm("clear")}
                  >
                    清除 Key
                  </Button>
                  <Button
                    tone="ghost"
                    disabled={Boolean(busy)}
                    onClick={() => setConfirm("remove")}
                  >
                    移除服务
                  </Button>
                </div>
                <p className="settings-section__hint">
                  读取模型列表不会生成内容。测试生成会发送短请求，可能产生费用。
                </p>
                {previousStatus && !onSaved ? (
                  <dl className="settings-section__evidence">
                    {(
                      [
                        ["transport", "服务"],
                        ["credential", "Key"],
                        ["modelAccess", "模型"],
                        ["tools", "工具"],
                      ] as const
                    ).map(([key, label]) => (
                      <div key={key}>
                        <dt>{label}</dt>
                        <dd>
                          {
                            {
                              ready: "已验证",
                              unknown: "未验证",
                              failed: "失败",
                              pending: "检查中",
                              unavailable: "不可用",
                              unsupported: "不支持",
                            }[previousStatus[key].state]
                          }
                          {previousStatus[key].reason
                            ? ` · ${previousStatus[key].reason}`
                            : ""}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </div>
            </Collapsible>
            {confirm ? (
              <SettingsFeedback tone="warning">
                <p>
                  {confirm === "clear"
                    ? "清除这个服务的 API Key？"
                    : `移除“${current.name}”？历史与画布结果会保留。`}
                </p>
                <div className="settings-section__actions">
                  <Button
                    disabled={Boolean(busy)}
                    onClick={() => setConfirm(null)}
                  >
                    取消
                  </Button>
                  <Button
                    tone="danger"
                    disabled={Boolean(busy)}
                    onClick={() => void destroy()}
                  >
                    {confirm === "clear" ? "确认清除" : "确认移除"}
                  </Button>
                </div>
              </SettingsFeedback>
            ) : null}
          </>
        ) : null}
      </SettingsSection>
    </div>
  );
}
