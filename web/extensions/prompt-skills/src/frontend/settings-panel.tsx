/**
 * prompt-skills 插件设置面板（change: prompt-skill-config-in-plugin）。
 *
 * 执行面板不再提供模型选择：改写模型属于插件配置。这里只做三件事——列出当前可执行的
 * 语言模型、显示/保存 `extensions.prompt-skills.model`、把 dirty/pending 上报给设置宿主。
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@woohaa3/ui/primitives";
import { SettingsFeedback, SettingsSection } from "@woohaa3/ui/settings";
import type { PromptSkillsSettingsRemote } from "./settings-remote.js";

export type PromptSkillsSettingsPanelProps = {
  remote: PromptSkillsSettingsRemote;
  reportEditState?: (state: { dirty?: boolean; pending?: boolean }) => void;
};

type Status = "loading" | "ready" | "error";

export function PromptSkillsSettingsPanel({ remote, reportEditState }: PromptSkillsSettingsPanelProps) {
  const [status, setStatus] = useState<Status>("loading");
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([]);
  const [selected, setSelected] = useState("");
  const [saved, setSaved] = useState("");
  const [revision, setRevision] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await remote.load();
      if (!result.ok) {
        setStatus("error");
        setError(result.error);
        return;
      }
      setModels(result.snapshot.models);
      setSelected(result.snapshot.model);
      setSaved(result.snapshot.model);
      setRevision(result.snapshot.revision);
      setStatus("ready");
    } catch {
      setStatus("error");
      setError("读取插件配置失败");
    } finally {
      setBusy(false);
    }
  }, [remote]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    reportEditState?.({ dirty: selected !== saved, pending: busy || status === "loading" });
  }, [reportEditState, busy, status, selected, saved]);

  const save = async () => {
    if (busy || status !== "ready" || selected === "" || selected === saved) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await remote.save({ model: selected, expectedRevision: revision });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(selected);
      setRevision(result.revision);
      setNotice("已保存，快捷改写会使用这个模型。");
    } catch {
      setError("保存插件配置失败");
    } finally {
      setBusy(false);
    }
  };

  // 配置里的模型可能已从目录消失：仍把它显示出来，避免保存时被静默改成列表首项。
  const options = selected === "" || models.some((entry) => entry.id === selected)
    ? models
    : [{ id: selected, label: `${selected}（当前配置，已不可用）` }, ...models];

  return (
    <SettingsSection
      title="快捷改写模型"
      description="执行面板的快捷改写使用这里选择的语言模型。只列出当前可执行的文本模型；看不到模型时，请先在「Provider 凭据」中配置并启用一个语言模型。"
      action={
        <Button size="sm" onClick={() => void load()} disabled={busy}>
          刷新
        </Button>
      }
    >
      {status === "loading" ? <SettingsFeedback>正在读取模型目录…</SettingsFeedback> : null}
      {status === "error" && error ? <SettingsFeedback tone="danger">{error}</SettingsFeedback> : null}
      {status === "ready" ? (
        <>
          {models.length === 0 && selected === "" ? (
            <SettingsFeedback tone="warning">没有可用的语言模型。请先配置并启用一个文本模型。</SettingsFeedback>
          ) : null}
          <label style={{ display: "block", marginTop: 8 }}>
            <span style={{ display: "block", marginBottom: 6, fontSize: 12, color: "var(--text-muted)" }}>语言模型</span>
            <select
              className="settings-page__select"
              style={{ width: "100%" }}
              value={selected}
              onChange={(event) => {
                setSelected(event.target.value);
                setNotice(null);
                setError(null);
              }}
              disabled={busy || options.length === 0}
            >
              {selected === "" ? <option value="">未选择</option> : null}
              {options.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
            <Button
              size="sm"
              onClick={() => void save()}
              disabled={busy || selected === "" || selected === saved}
            >
              保存
            </Button>
            {selected !== saved ? <span style={{ fontSize: 12, color: "var(--text-muted)" }}>有未保存的修改</span> : null}
          </div>
          {error ? <SettingsFeedback tone="danger">{error}</SettingsFeedback> : null}
          {notice ? <SettingsFeedback tone="success">{notice}</SettingsFeedback> : null}
        </>
      ) : null}
    </SettingsSection>
  );
}
