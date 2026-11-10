import { useSyncExternalStore, useState } from "react";
import { getAppPublicFetch } from "../../services/app-base-path.js";
import { Button } from "@woohaa3/ui/primitives";

import { runtimeComponents } from "../../services/runtime-components.js";

const LABELS: Record<string, string> = { codex: "Codex", claude: "Claude", dsh: "DeepSeek DSH", "shot-recorder": "视频录制", "model-renderer": "模型渲染" };
const STATUSES: Record<string, string> = { missing: "未安装", checking: "检查中", downloading: "下载运行包", verifying: "校验中", extracting: "解压中", preparing: "准备中", ready: "可用", failed: "准备失败", incompatible: "版本不兼容", unavailable: "不可用" };
const SOURCES: Record<string, string> = { "npm-registry": "npm registry", managed: "CDN 下载", local: "本机程序" };
const BUSY = new Set(["checking", "downloading", "verifying", "extracting", "preparing"]);

export type RuntimeComponentsSectionProps = { source?: typeof runtimeComponents; fetcher?: typeof fetch };
export function RuntimeComponentsSection({ source = runtimeComponents, fetcher = (input, init) => getAppPublicFetch()(input, init) }: RuntimeComponentsSectionProps = {}) {
  const runtimeState = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const snapshot = runtimeState.snapshot;
  const [error, setError] = useState("");
  const [pending, setPending] = useState<string>();
  const [paths, setPaths] = useState<Record<string, string>>({});
  const request = async (suffix = "", body?: unknown) => {
    const response = await fetcher(`/api/runtime-components${suffix}`, body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.message ?? "组件服务请求失败");
    return value;
  };
  const runtimePath = (id: string) => {
    const component = snapshot?.components.find((item) => item.id === id);
    return component?.path ?? (component?.source === "local" ? component.entry : undefined);
  };
  const candidatePath = (id: string) => paths[id] ?? runtimePath(id);
  const act = async (id: string, action: string, body: unknown = {}) => {
    setPending(id); setError("");
    try {
      const value = await request(`/${id}/${action}`, body);
      if (action === "discover") {
        const first = value.candidates?.[0];
        if (first) setPaths((previous) => ({ ...previous, [id]: typeof first === "string" ? first : first.entry }));
        // A path that was typed but cannot run (for example an npm shim while the packaged App has
        // no `node` on PATH) would otherwise look identical to "nothing found".
        else if (value.selected?.error) setError(`该路径不可用：${value.selected.error}`);
        else setError("未找到本机程序，请填写绝对路径。");
      }
      await source.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "组件操作失败"); }
    finally { setPending(undefined); }
  };
  const installEnabled = snapshot?.policy?.installEnabled !== false && snapshot?.available !== false;
  const sourceOf = (component: { source: keyof typeof SOURCES | string }) => SOURCES[component.source] ?? component.source;
  return <div className="settings-page__list settings-runtime">
    <p className="settings-page__hint">基础画布可离线使用。Agent 运行时在首次使用前按应用锁定版本从 npm registry 安装到用户目录；也可选择已有的本机程序。</p>
    {error || runtimeState.error ? <p className="settings-page__error">{error || runtimeState.error}</p> : null}
    {!snapshot ? <p>正在读取组件状态…</p> : !snapshot.available ? <p>{snapshot.message ?? "管理员未启用运行时安装。"}</p> : <>
      {!installEnabled ? <p className="settings-page__error">{snapshot.message ?? "管理员未启用运行时安装。"}</p> : null}
      {snapshot.components.map((component) => {
        const busy = BUSY.has(component.status);
        const disabled = pending === component.id || !installEnabled;
        return <section key={component.id} className="settings-runtime__component">
          <div className="settings-runtime__summary">
            <strong>{LABELS[component.id] ?? component.id}</strong>
            <p>{component.version} · {STATUSES[component.status] ?? component.status} · {sourceOf(component)}{component.requests ? ` · ${component.requests} 个包` : ""}</p>
          </div>
          {component.engine ? <p className="settings-page__hint">{component.engine} · {component.registry}</p> : null}
          {component.progress ? <p>{component.source === "npm-registry" ? `已获取 ${component.progress.received} / ${component.progress.total} 个运行包` : `已下载 ${(component.progress.received / 1048576).toFixed(1)} MB${component.progress.total ? ` / ${(component.progress.total / 1048576).toFixed(1)} MB` : ""}`}</p> : null}
          {component.error ? <p className="settings-page__error">{component.error}</p> : null}
          {component.entry ? <p className="settings-page__hint">{component.entry}</p> : null}
          <div className="settings-runtime__actions">
            {busy ? <Button size="sm" disabled={pending === component.id} onClick={() => void act(component.id, "cancel")}>取消</Button> : <>
              {snapshot.policy?.sources?.includes("npm-registry") && component.source !== "npm-registry" ? <Button size="sm" disabled={disabled} onClick={() => void act(component.id, "configure", { source: "npm-registry" })}>使用 npm registry</Button> : null}
              {component.source === "managed" ? <Button size="sm" disabled={disabled} onClick={() => void act(component.id, "install")}>{component.status === "failed" ? "重试下载" : "下载组件"}</Button> : null}
              {component.source === "npm-registry" ? <Button size="sm" disabled={disabled} onClick={() => void act(component.id, "install")}>{component.status === "ready" ? "重新准备" : "准备运行时"}</Button> : null}
              {component.source !== "local" ? <Button size="sm" disabled={disabled} onClick={() => void act(component.id, "remove")}>删除运行时</Button> : null}
            </>}
          </div>
          {!busy && installEnabled && (component.id === "codex" || component.id === "claude") ? <div className="settings-runtime__local">
              <input className="settings-page__input" placeholder="本机程序的绝对路径" value={candidatePath(component.id) ?? ""} onChange={(event) => setPaths({ ...paths, [component.id]: event.target.value })} />
              <Button size="sm" disabled={pending === component.id} onClick={() => void act(component.id, "discover", { path: candidatePath(component.id) ?? "" })}>探测本机程序</Button>
              <Button size="sm" disabled={pending === component.id || !candidatePath(component.id)} onClick={() => void act(component.id, "configure", { source: "local", path: candidatePath(component.id) })}>使用此程序</Button>
            </div> : null}
        </section>;
      })}
    </>}
  </div>;
}
