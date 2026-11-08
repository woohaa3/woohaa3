/**
 * 设置 · 关于：只展示**运行时能判定**的事实，不伪造版本或环境。
 *
 * 这里刻意解答「为什么生成任务说没有对外地址」：把主存储、对外地址提供者、已注册的
 * 扩展点与公开临时桶的启用/注册状态摊开，用户不用去翻日志。
 */
import type { ReactNode } from "react";
import type { SettingsSnapshot } from "@woohaa3/contracts";
import { appBuildVersion } from "../../services/build-info.js";

function settingValue(snapshot: SettingsSnapshot | null, key: string): string {
  const entry = snapshot?.settings.find((item) => item.key === key);
  if (entry === undefined || entry.value === null || entry.value === "") return "";
  return String(entry.value);
}

function providersText(providers: ReadonlyArray<{ id: string; label: string }> | undefined): string {
  if (providers === undefined || providers.length === 0) return "无";
  return providers.map((provider) => provider.label).join("、");
}

function Row({ label, children, testId }: { label: string; children: ReactNode; testId: string }) {
  return (
    <li className="settings-page__item" data-testid={testId}>
      <div className="settings-page__item-head">
        <span className="settings-page__item-label">{label}</span>
      </div>
      <p className="settings-page__item-description">{children}</p>
    </li>
  );
}

export function AboutSection({ snapshot }: { snapshot: SettingsSnapshot | null }) {
  const version = appBuildVersion();
  const storagePrimary = settingValue(snapshot, "storage.primary");
  const exposerPrimary = settingValue(snapshot, "exposer.primary");
  const storageProviders = snapshot?.extensionPoints?.storage;
  const exposerProviders = snapshot?.extensionPoints?.exposer;
  const exposerProvider = exposerProviders?.find((provider) => provider.id === exposerPrimary);
  const exposerRegistered = exposerPrimary !== "" && exposerProvider !== undefined;
  const platform = typeof navigator === "undefined" ? "未知" : navigator.platform || navigator.userAgent;
  const language = typeof navigator === "undefined" ? "" : navigator.language;

  return (
    <ul className="settings-page__list" data-testid="settings-about">
      <Row label="应用版本" testId="settings-about-version">
        {version !== "" ? <code>{version}</code> : <span>未注入（开发构建或非发布产物）</span>}
        <span className="settings-page__hint"> 发布构建自报 `desktop/tauri.conf.json` 的版本。</span>
      </Row>
      <Row label="运行环境" testId="settings-about-platform">
        <code>{platform}</code>
        {language !== "" ? <> · {language}</> : null}
      </Row>
      <Row label="主存储后端" testId="settings-about-storage">
        {storagePrimary !== "" ? <code>{storagePrimary}</code> : <span>未设置（缺省 local）</span>}
        <span className="settings-page__hint"> · 已注册：{providersText(storageProviders)}</span>
      </Row>
      <Row label="临时图床" testId="settings-about-exposer">
        {exposerPrimary !== "" && exposerPrimary !== "auto" ? (
          <>
            <code>{exposerProvider?.label ?? exposerPrimary}</code>
            {!exposerRegistered ? <span className="settings-page__badge is-warning">已选择但未注册</span> : null}
          </>
        ) : (
          <code>自动</code>
        )}
        <span className="settings-page__hint"> · 已注册：{providersText(exposerProviders)}</span>
      </Row>
      <Row label="配置文件" testId="settings-about-files">
        <code className="settings-about__path">{snapshot?.files.config ?? "—"}</code>
        <span className="settings-about__path-label">密钥文件</span>
        <code className="settings-about__path">{snapshot?.files.secrets ?? "—"}</code>
      </Row>
      <Row label="已安装扩展" testId="settings-about-extensions">
        {snapshot?.installedExtensions?.length ?? 0} 个
        {snapshot?.safeMode ? <span className="settings-page__badge is-warning">安全模式</span> : null}
      </Row>
    </ul>
  );
}
