/**
 * 图像 › 模式与颜色表…（change: 2026-10-22-add-photocraft-image-mode-workflows）。
 *
 * 入口已注册：发布前置全部落地——颜色表与油墨进入内容身份
 * （`document_content::project_content` + `identity::canonicalize`）、能力与命令发布到 P7
 * （`tests/fixtures/contract.json` 与 WASM 基线同步）、原生核验接入
 * （`verify_container_with` 调用 `features::modes::validate_document`）。
 *
 * 面板只用本域的 `planMode`/`applyMode`/`planColorTable`/`applyColorTable`；跨域写入限制由
 * `features::modes::gate` 在唯一命令门之后执行，因此界面提示与内核拒绝一致。
 */
import type { FeaturePanelContext } from "../panel-context.js";
import { ModesPanel } from "./panels.js";

export const sections = [
  { id: "modes", order: 12, placement: "advanced", menu: "图像",
    label: "模式与颜色表…", menuOrder: 3,
    render: (context: FeaturePanelContext) => (
      <div key="modes" className="photo-editor__advanced-section" data-advanced-section="modes">
        <ModesPanel {...context} />
      </div>
    ) }
] as const;
