/**
 * Ark 模型接入点：从目录里勾选模型，再填写这个模型的推理接入点。
 *
 * 每个模型是一条设置项（`providers.ark.ep.<类型>.<模型ID>`），这里不把它们渲染成普通文本框。
 */
import { useState } from "react";
import type { SettingsEntryView, SettingsWriteValue } from "@woohaa3/contracts";
import { Button } from "../../../shared/ui/Button.js";
import { Switch } from "../../../shared/ui/Switch.js";
import type { BackendSettingsStore } from "./backend-settings-store.js";

const ENDPOINT_KEY = /^providers\.ark\.ep\.(language|image|video)\.(.+)$/;
const ENDPOINT_ID = /^ep-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

const KIND_LABEL: Record<string, string> = {
  language: "文本",
  image: "图像",
  video: "视频"
};

const KIND_ORDER = ["language", "image", "video"];

export function isArkEndpointEntry(entry: SettingsEntryView): boolean {
  return ENDPOINT_KEY.test(entry.key);
}

export function ArkEndpointSection({
  entries,
  store,
  inactive
}: {
  entries: readonly SettingsEntryView[];
  store: BackendSettingsStore;
  inactive: boolean;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const rows = entries.flatMap((entry) => {
    const match = ENDPOINT_KEY.exec(entry.key);
    if (!match) return [];
    const kind = match[1] ?? "";
    const modelId = match[2] ?? "";
    if (needle && !entry.label.toLowerCase().includes(needle) && !modelId.toLowerCase().includes(needle)) return [];
    return [{ entry, kind, modelId }];
  });
  const configured = entries.filter((entry) => typeof entry.value === "string" && entry.value.trim() !== "").length;
  return (
    <section data-testid="ark-endpoint-section">
      <h3 className="settings-page__group-title">模型接入点</h3>
      <p className="settings-page__hint">
        勾选要用的模型，再填写它在方舟上的推理接入点（ep- 开头）。没勾选或留空的模型不会提供。
        {inactive ? "插件启用后生效。" : ""}
      </p>
      <p className="settings-page__hint" data-testid="ark-endpoint-summary">已配置 {configured} / {entries.length}</p>
      <input
        className="settings-page__input"
        value={query}
        placeholder="筛选模型"
        onChange={(event) => setQuery(event.target.value)}
        data-testid="ark-endpoint-filter"
      />
      {KIND_ORDER.map((kind) => {
        const group = rows.filter((row) => row.kind === kind);
        if (group.length === 0) return null;
        return (
          <div key={kind} className="ark-endpoints__group">
            <h4 className="ark-endpoints__kind">{KIND_LABEL[kind]}</h4>
            <ul className="settings-page__list ark-endpoints">
              {group.map((row) => (
                <ArkEndpointRow key={`${row.entry.key}:${String(row.entry.value ?? "")}`} entry={row.entry} modelId={row.modelId} store={store} />
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

function ArkEndpointRow({
  entry,
  modelId,
  store
}: {
  entry: SettingsEntryView;
  modelId: string;
  store: BackendSettingsStore;
}) {
  const saved = typeof entry.value === "string" ? entry.value : "";
  const [on, setOn] = useState(saved !== "");
  const [draft, setDraft] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = entry.lockedBy !== null;
  const dirty = draft.trim() !== saved;

  const save = async (value: SettingsWriteValue) => {
    setBusy(true);
    setError(null);
    const result = await store.save({ [entry.key]: value });
    setBusy(false);
    if (!result.ok) setError(result.issues.find((issue) => issue.key === entry.key)?.message ?? result.error);
  };

  const toggle = (next: boolean) => {
    setOn(next);
    setError(null);
    if (!next) {
      setDraft("");
      if (saved) void save(null);
    }
  };

  const saveDraft = () => {
    const value = draft.trim();
    if (!ENDPOINT_ID.test(value)) {
      setError("接入点需要是 ep- 开头");
      return;
    }
    void save(value);
  };

  return (
    <li className="ark-endpoints__row" data-model-id={modelId}>
      <div className="ark-endpoints__main">
        <div className="plugin-config__model-text">
          <span className="plugin-config__model-name">{entry.label}</span>
          <span className="plugin-config__model-meta">{modelId}</span>
        </div>
        <Switch
          checked={on}
          disabled={locked || busy}
          onCheckedChange={toggle}
          aria-label={`${entry.label}：${on ? "使用" : "不使用"}`}
          testId={`ark-endpoint-toggle-${modelId}`}
        />
      </div>
      {locked ? (
        <p className="settings-page__hint">由环境变量 <code>{entry.lockedBy}</code> 锁定。</p>
      ) : null}
      {on ? (
        <div className="settings-page__item-control">
          <input
            className="settings-page__input"
            value={locked ? saved : draft}
            placeholder="ep-…"
            autoComplete="off"
            spellCheck={false}
            disabled={locked || busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && dirty) saveDraft();
            }}
            data-testid={`ark-endpoint-input-${modelId}`}
          />
          <Button size="sm" tone="primary" disabled={locked || busy || !dirty} loading={busy} onClick={saveDraft} data-testid={`ark-endpoint-save-${modelId}`}>
            保存
          </Button>
        </div>
      ) : null}
      {error ? <p className="settings-page__error" role="alert">{error}</p> : null}
    </li>
  );
}
