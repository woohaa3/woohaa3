import { useSyncExternalStore, useState } from "react";
import { getAppPublicFetch } from "../../services/app-base-path.js";
import { Button } from "../../../shared/ui/Button.js";

import { runtimeComponents } from "../../services/runtime-components.js";

const LABELS: Record<string, string> = { "image-editor": "图片编辑", codex: "Codex", claude: "Claude", dsh: "DeepSeek DSH", "shot-recorder": "视频录制", "model-renderer": "模型渲染" };
const STATUSES: Record<string, string> = { missing: "未安装", checking: "检查中", downloading: "下载中", verifying: "校验中", extracting: "解压中", ready: "可用", failed: "安装失败", incompatible: "版本不兼容" };
const BUSY = new Set(["checking", "downloading", "verifying", "extracting"]);

export function RuntimeComponentsSection() {
  const runtimeState = useSyncExternalStore(runtimeComponents.subscribe, runtimeComponents.getSnapshot, runtimeComponents.getSnapshot);
  const snapshot = runtimeState.snapshot;
  const [error, setError] = useState("");
  const [pending, setPending] = useState<string>();
  const [paths, setPaths] = useState<Record<string, string>>({});
  const request = async (suffix = "", body?: unknown) => {
    const response = await getAppPublicFetch()(`/api/runtime-components${suffix}`, body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.message ?? "组件服务请求失败");
    return value;
  };
  const act = async (id: string, action: string, body: unknown = {}) => {
    setPending(id); setError("");
    try {
      const value = await request(`/${id}/${action}`, body);
      if (action === "discover") {
        const first = value.candidates?.[0];
        if (first) setPaths((previous) => ({ ...previous, [id]: typeof first === "string" ? first : first.entry }));
        else setError("未找到本机程序，请填写绝对路径。");
      }
      await runtimeComponents.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "组件操作失败"); }
    finally { setPending(undefined); }
  };
  return <div className="settings-page__list">
    <p className="settings-page__hint">基础画布可离线使用。可选组件只在点击下载后联网，安装后可离线使用；也可选择已有的 Codex 或 Claude 程序。</p>
    <p className="settings-page__hint">下载源配置：{snapshot?.configPath ?? "<App 用户数据目录>/config/runtime-downloads.json"}。发行默认配置位于 desktop/runtime-downloads.json。</p>
    {error || runtimeState.error ? <p className="settings-page__error">{error || runtimeState.error}</p> : null}
    {!snapshot ? <p>正在读取组件状态…</p> : !snapshot.available ? <p>运行时组件仅在桌面 App 中可用。</p> : snapshot.components.map((component) => {
      const busy = BUSY.has(component.status);
      const disabled = pending === component.id;
      return <section key={component.id} className="settings-services__ctx">
        <strong>{LABELS[component.id] ?? component.id}</strong>
        <p>{component.version} · {STATUSES[component.status] ?? component.status} · {component.source === "local" ? "本机程序" : "CDN 下载"}</p>
        {component.progress ? <p>已下载 {(component.progress.received / 1048576).toFixed(1)} MB{component.progress.total ? ` / ${(component.progress.total / 1048576).toFixed(1)} MB` : ""}</p> : null}
        {component.error ? <p className="settings-page__error">{component.error}</p> : null}
        {component.entry ? <p className="settings-page__hint">{component.entry}</p> : null}
        {busy ? <Button size="sm" disabled={disabled} onClick={() => void act(component.id, "cancel")}>取消下载</Button> : <>
          <Button size="sm" disabled={disabled} onClick={() => void (async () => { await act(component.id, "configure", { source: "managed" }); })()}>使用 CDN 组件</Button>{" "}
          <Button size="sm" disabled={disabled || component.source !== "managed"} onClick={() => void act(component.id, "install")}>{component.status === "failed" ? "重试下载" : "下载组件"}</Button>{" "}
          <Button size="sm" disabled={disabled || component.source !== "managed"} onClick={() => void act(component.id, "remove")}>删除托管组件</Button>
          {component.id === "codex" || component.id === "claude" ? <div>
            <input className="settings-row__input" placeholder="本机程序的绝对路径" value={paths[component.id] ?? component.path ?? (component.source === "local" ? component.entry : "") ?? ""} onChange={(event) => setPaths({ ...paths, [component.id]: event.target.value })} />{" "}
            <Button size="sm" disabled={disabled} onClick={() => void act(component.id, "discover")}>探测本机程序</Button>{" "}
            <Button size="sm" disabled={disabled || !(paths[component.id] ?? component.path ?? (component.source === "local" ? component.entry : undefined))} onClick={() => void act(component.id, "configure", { source: "local", path: paths[component.id] ?? component.path ?? component.entry })}>使用此程序</Button>
          </div> : null}
        </>}
      </section>;
    })}
  </div>;
}
