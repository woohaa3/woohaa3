/**
 * 单个配置项的编辑行：值、来源与生效方式，按项保存。
 *
 * 敏感项不回显，只显示已配置 / 未配置；被旧环境变量锁定的项只读，并提示迁移到配置文件。
 * 「核心服务」与「插件详情」共用这一行：插件卡片里的配置项也是同一份 `/api/settings` 数据。
 *
 * 逐项保存的语义不变（change: 2026-10-17-move-settings-into-canvas-dialog，任务 3.3）：
 * 行把「未保存输入 / 保存中」上报给设置 edit-session；任一写请求进行中时关闭与内部导航会被
 * 拒绝，成功保存后以权威快照重设基线并清空密钥输入。
 */
import { useState, type ReactNode } from "react";
import type { SettingsEntryView, SettingSource, SettingsWriteValue } from "@woohaa3/contracts";
import { Button } from "@woohaa3/ui/primitives";
import { Switch } from "@woohaa3/ui/primitives";
import type { BackendSettingsStore } from "./backend-settings-store.js";
import type { SettingsEditSession } from "./edit-session.js";
import { useSettingsEditReport } from "./workspace/use-settings-edit-report.js";

const SOURCE_LABEL: Record<SettingSource, string> = {
  default: "默认值",
  file: "配置文件",
  secrets: "密钥文件",
  env: "环境变量"
};

export function SettingRow({
  entry,
  store,
  inactive = false,
  editSession,
  options,
  renderRelated
}: {
  entry: SettingsEntryView;
  store: BackendSettingsStore;
  /** 所属插件没在运行：hot 项现在写了也不生效，徽标不能继续说「即时生效」。 */
  inactive?: boolean;
  /** 设置工作区的编辑会话；缺省（例如凭据弹窗）不参与退出保护。 */
  editSession?: SettingsEditSession;
  /** 扩展点选择项的可选提供者；给出后渲染选择器而不是自由文本，避免手写不存在的 id。 */
  options?: readonly { value: string; label: string }[];
  /** 扩展点选择项的关联提供者（跟随当前草稿值）；缺省不渲染。 */
  renderRelated?: (value: string) => ReactNode;
}) {
  const entryBaseline = entry.secret || entry.value === null ? "" : String(entry.value);
  const [draft, setDraft] = useState(entryBaseline);
  // 保存成功后以**权威提交值**重设基线；权威快照随后回流只会带来源/已配置状态变化。
  const [baseline, setBaseline] = useState(entryBaseline);
  const [busy, setBusy] = useState<false | "test" | "save" | "save-anyway">(false);
  const [error, setError] = useState<string | null>(null);
  const [testNotice, setTestNotice] = useState<string | null>(null);
  const [testFailed, setTestFailed] = useState(false);
  const locked = entry.lockedBy !== null;
  const isProviderSecret = entry.secret && entry.key.startsWith("providers.");

  const parsedDraft = (): SettingsWriteValue => (entry.kind === "integer" ? Number(draft) : draft.trim());
  const dirty = entry.secret ? draft.trim() !== "" : draft.trim() !== baseline.trim();
  const related = renderRelated?.(draft.trim()) ?? null;
  const clearable = !locked && (entry.source === "file" || entry.source === "secrets");

  // 只在该行参与设置工作区时汇总；凭据弹窗等独立语境不受影响。
  useSettingsEditReport(editSession, `row:${entry.key}`, { dirty, pending: Boolean(busy) });

  const runTest = async () => {
    if (busy || !store.test) return;
    setBusy("test");
    setError(null);
    setTestNotice(null);
    try {
      const value = dirty ? parsedDraft() : undefined;
      const payload = value !== undefined ? { [entry.key]: value } : { [entry.key]: entry.value ?? "" };
      const result = await store.test(payload);
      if (result.ok) {
        setTestFailed(false);
        setTestNotice(result.message || "测试通过");
      } else {
        setTestFailed(true);
        setError(result.issues.find((issue) => issue.key === entry.key)?.message ?? result.error);
      }
    } catch {
      setTestFailed(true);
      setError("连接测试失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const save = async (value: SettingsWriteValue, force = false) => {
    setBusy(force ? "save-anyway" : "save");
    setError(null);
    setTestNotice(null);
    if (isProviderSecret && value !== null && !force && store.test) {
      try {
        const tested = await store.test({ [entry.key]: value });
        if (!tested.ok) {
          setBusy(false);
          setTestFailed(true);
          setError(tested.issues.find((issue) => issue.key === entry.key)?.message ?? tested.error);
          return;
        }
      } catch {
        setBusy(false);
        setTestFailed(true);
        setError("连接测试失败，请重试。");
        return;
      }
    }
    setTestFailed(false);
    const result = await store.save({ [entry.key]: value });
    setBusy(false);
    if (!result.ok) {
      setError(result.issues.find((issue) => issue.key === entry.key)?.message ?? result.error);
      return;
    }
    // 成功：重设基线并清空密钥输入（明文不留在界面或任何持久载体上）。
    if (entry.secret) {
      setDraft("");
      setBaseline("");
    } else {
      const next = value === null ? "" : String(value);
      setDraft(next);
      setBaseline(next);
    }
  };

  return (
    <li className="settings-page__item" data-setting-key={entry.key}>
      <div className="settings-page__item-head">
        <span className="settings-page__item-label">{entry.label}</span>
        <code className="settings-page__item-key">{entry.key}</code>
        <span className="settings-page__badge">{entry.reload === "hot" ? (inactive ? "启用后生效" : "即时生效") : "重启后生效"}</span>
        {entry.pendingRestart ? <span className="settings-page__badge is-warning">等待重启</span> : null}
        <span className="settings-page__badge is-muted" data-testid={`setting-source-${entry.key}`}>
          {entry.source ? SOURCE_LABEL[entry.source] : "未设置"}
        </span>
      </div>
      <p className="settings-page__item-description">{entry.description}</p>
      {locked ? (
        <p className="settings-page__hint" data-testid={`setting-locked-${entry.key}`}>
          由环境变量 <code>{entry.lockedBy}</code> 锁定。环境变量只为过渡兼容保留，移除它后才能在这里修改。
        </p>
      ) : null}
      <div className="settings-page__item-control">
        {entry.kind === "boolean" ? (
          <Switch
            checked={entry.value === true}
            disabled={locked || Boolean(busy)}
            onCheckedChange={(next) => void save(next)}
            aria-label={entry.label}
            testId={`setting-input-${entry.key}`}
          />
        ) : options ? (
          <>
            {/* 扩展点选择用原生 select：设置弹窗内没有可用的浮层容器（portal 根在弹窗层之下），
                原生控件不受层级与 overflow 裁切影响；与任务历史等页面的既有选择控件一致。 */}
            <select
              className="settings-page__select"
              value={draft}
              disabled={locked || Boolean(busy)}
              aria-label={entry.label}
              onChange={(event) => { setDraft(event.target.value); setTestFailed(false); setTestNotice(null); }}
              data-testid={`setting-select-${entry.key}`}
            >
              {options.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <Button size="sm" tone="primary" disabled={locked || Boolean(busy) || !dirty} loading={busy === "save"} onClick={() => void save(parsedDraft())} data-testid={`setting-save-${entry.key}`}>
              保存
            </Button>
          </>
        ) : (
          <>
            <input
              className="settings-page__input"
              type={entry.secret ? "password" : entry.kind === "integer" ? "number" : "text"}
              autoComplete="off"
              spellCheck={false}
              value={locked && !entry.secret ? String(entry.value ?? "") : draft}
              placeholder={entry.secret ? (entry.configured ? "已配置，输入以覆盖" : "未配置") : entry.kind === "url" ? `${(entry.protocols ?? []).join(" / ")}//…` : ""}
              disabled={locked || Boolean(busy)}
              onChange={(event) => { setDraft(event.target.value); setTestFailed(false); setTestNotice(null); }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && dirty) void save(parsedDraft());
              }}
              data-testid={`setting-input-${entry.key}`}
            />
            {isProviderSecret ? (
              <Button
                size="sm"
                tone="ghost"
                disabled={locked || Boolean(busy) || (!dirty && !entry.configured)}
                loading={busy === "test"}
                onClick={() => void runTest()}
                data-testid={`setting-test-${entry.key}`}
              >
                测试
              </Button>
            ) : null}
            {isProviderSecret && testFailed ? (
              <Button
                size="sm"
                tone="ghost"
                disabled={locked || Boolean(busy) || !dirty}
                loading={busy === "save-anyway"}
                onClick={() => void save(parsedDraft(), true)}
                data-testid={`setting-save-anyway-${entry.key}`}
              >
                仍然保存
              </Button>
            ) : null}
            <Button size="sm" tone="primary" disabled={locked || Boolean(busy) || !dirty} loading={busy === "save"} onClick={() => void save(parsedDraft())} data-testid={`setting-save-${entry.key}`}>
              保存
            </Button>
          </>
        )}
        {clearable ? (
          <Button size="sm" tone="ghost" disabled={Boolean(busy)} onClick={() => void save(null)} data-testid={`setting-clear-${entry.key}`}>
            清除
          </Button>
        ) : null}
      </div>
      {related ? (
        <p className="settings-page__related" data-testid={`setting-related-${entry.key}`}>
          {related}
        </p>
      ) : null}
      {testNotice ? <p className="settings-page__hint">{testNotice}</p> : null}
      {error ? <p className="settings-page__error" role="alert">{error}</p> : null}
    </li>
  );
}
