/**
 * 片场组外显镜头节点的只读参数面板。
 *
 * 选中这类节点时不再沿用图片/视频生成面板（它们没有可编辑的生成配置），
 * 只展示镜头输出参数：分辨率、画面比例、时长、帧率与循环。
 */
import { CloseIcon } from "@woohaa3/ui";
import { ExecutionPanelShell } from "../../ui/index.js";
import { formatShotDuration, type ShotMediaParameters } from "./shot-media-parameters.js";
import "./shot-media-parameters-panel.css";

export type ShotMediaParametersPanelProps = {
  nodeId: string;
  parameters: ShotMediaParameters;
  onClose?: (() => void) | undefined;
};

export function ShotMediaParametersPanel({ nodeId, parameters, onClose }: ShotMediaParametersPanelProps) {
  const video = parameters.kind === "video";
  return (
    <ExecutionPanelShell ariaLabel={video ? "镜头视频参数" : "镜头图片参数"} className="mc-panel--shot-media">
      <div className="shot-media-panel" data-node-id={nodeId} data-media-kind={parameters.kind}>
        <header className="shot-media-panel__header">
          <div className="shot-media-panel__heading">
            <strong className="shot-media-panel__title">{parameters.title}</strong>
            <span className="shot-media-panel__kind">{video ? "视频" : "图片"}</span>
          </div>
          {onClose ? (
            <button type="button" className="mc-panel__close" data-tooltip="关闭" aria-label="关闭执行面板" onClick={onClose}>
              <CloseIcon className="mc-panel__icon" />
            </button>
          ) : null}
        </header>
        <dl className="shot-media-panel__params">
          <div className="shot-media-panel__param">
            <dt>分辨率</dt>
            <dd>{`${parameters.width} × ${parameters.height}`}</dd>
          </div>
          <div className="shot-media-panel__param">
            <dt>画幅比例</dt>
            <dd>{parameters.aspect}</dd>
          </div>
          {video ? (
            <>
              <div className="shot-media-panel__param">
                <dt>时长</dt>
                <dd>{formatShotDuration(parameters.durationSeconds)}</dd>
              </div>
              <div className="shot-media-panel__param">
                <dt>帧率</dt>
                <dd>{`${parameters.frameRate} fps`}</dd>
              </div>
              <div className="shot-media-panel__param">
                <dt>播放</dt>
                <dd>{parameters.loop ? "循环" : "单次"}</dd>
              </div>
            </>
          ) : null}
        </dl>
        <p className="shot-media-panel__hint">由所属片场镜头托管，参数只读；请在片场检查器中修改镜头。</p>
      </div>
    </ExecutionPanelShell>
  );
}
