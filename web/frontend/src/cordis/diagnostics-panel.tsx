/**
 * Runtime diagnostics 面板（change: adopt-frontend-cordis-plugin-runtime，design D10）。
 *
 * 只在开发期渲染非敏感摘要：Plugin ID、状态、缺失 Service 与失败原因。生产构建不输出
 * 凭据、媒体签名 URL 或 prompt 正文。
 */
import { useRuntimeStatus } from "./react.js";

export function RuntimeDiagnosticsPanel() {
  const status = useRuntimeStatus();
  const dev = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV ?? false;
  if (!dev) return null;
  const failed = status.plugins.filter((plugin) => plugin.status === "failed" || plugin.missingServices.length > 0);
  if (failed.length === 0) return null;
  return (
    <div className="runtime-diagnostics" data-testid="runtime-diagnostics">
      {failed.map((plugin) => (
        <div key={plugin.id}>
          <strong>{plugin.id}</strong>
          {plugin.missingServices.length > 0 ? <span> 缺失：{plugin.missingServices.join(", ")}</span> : null}
          {plugin.status === "failed" ? <span> 启动失败</span> : null}
        </div>
      ))}
    </div>
  );
}
