/** 聚焦标题栏的创建入口与创建弹窗内容，三个入口共用控制器。 */
import { useState, useSyncExternalStore } from "react";
import type { FilmSetConversionModelCandidate, FilmSetConversionSettings, FilmSetConversionSourceKind, ServerCanvas } from "@woohaa3/contracts";
import { AssistantComposer, AssistantDeliverySelection, AssistantToolbar, Button, FilmIcon, type AgentConversationService } from "@woohaa3/frontend/extension-api";
import { type FilmSetConversionController } from "./controller.js";
import { resolveFilmSetConversionAvailability } from "./view.js";
import type { FilmSetConversionPreferenceStore } from "./preference.js";

export type FilmSetConversionActionDependencies = {
  assistant?: AgentConversationService;
  canvasId: string;
  controller: FilmSetConversionController;
  preferences: FilmSetConversionPreferenceStore;
  getCanvas: () => ServerCanvas | null;
  subscribeCanvas: (listener: () => void) => () => void;
  openConnectChatGpt?: () => void;
  openConfigureModel?: () => void;
  openFilmSet?: (nodeId: string) => void;
};
export type FilmSetConversionActionProps = { nodeId: string; nodeType: string; writable: boolean; deps: FilmSetConversionActionDependencies };

export function FilmSetConversionAction({ nodeId, nodeType, writable, deps }: FilmSetConversionActionProps) {
  const canvas = useSyncExternalStore(deps.subscribeCanvas, deps.getCanvas, () => null);
  const availability = resolveFilmSetConversionAvailability({ canvas, nodeId, nodeType, writable });
  return <Button size="sm" tone="primary" icon={<FilmIcon />}
    disabled={!availability.available}
    title={availability.available ? "保留原素材，创建独立片场" : availability.reason}
    data-testid={`film-set-conversion-start:${nodeId}`}
    onClick={() => { void deps.controller.activate({ nodeId, nodeType, writable }); }}>创建片场</Button>;
}

/** 与执行面板一致：提示词为主体，模型与主操作在底部并排。 */
export function FilmSetConversionSettingsPanel(props: {
  assistant?: AgentConversationService;
  kind: FilmSetConversionSourceKind;
  models: readonly FilmSetConversionModelCandidate[];
  modelsLoaded: boolean;
  draft: FilmSetConversionSettings;
  disabled: boolean;
  busy: boolean;
  needsConfiguration: boolean;
  error?: string | null;
  openConnectChatGpt?: () => void;
  openConfigureModel?: () => void;
  onRefreshModels?: () => void;
  onDraftChange: (settings: FilmSetConversionSettings) => void;
  onStart: () => void;
}) {
  const [validAssistant, setValidAssistant] = useState(false);
  const validModel = Boolean(props.draft.modelKey) && validAssistant;
  const submit = <Button tone="primary" loading={props.busy} disabled={props.disabled || !validModel} onClick={props.onStart}>创建片场</Button>;
  return <div className="film-set-conversion-settings" data-source-kind={props.kind}>
    <AssistantComposer className="film-set-conversion-settings__prompt" rows={6}
      placeholder="描述希望生成的场景，或修改默认提示词。留空使用内置提示词。"
      value={props.draft.instruction ?? ""} disabled={props.busy}
      onChange={instruction => props.onDraftChange({ ...props.draft, instruction })}
      onSubmit={() => { if (!props.disabled && !props.busy && validModel) props.onStart(); }} />
    <div className="film-set-conversion-settings__footer">
        {props.assistant ? <AssistantDeliverySelection service={props.assistant} candidates={props.models} sourceKind={props.kind} value={props.draft}
          disabled={props.busy} onChange={props.onDraftChange} onValidityChange={setValidAssistant} onManage={props.openConfigureModel}
          onRefresh={props.onRefreshModels} submit={submit} /> : <AssistantToolbar disabled={props.busy} onManage={props.openConfigureModel} onRefresh={props.onRefreshModels} submit={submit} notice={<p>助手会话服务尚未就绪</p>} />}
    </div>
    <p className="film-set-conversion-settings__hint">Ctrl / ⌘ + Enter 创建</p>
    {props.error ? <div className="film-set-conversion-settings__error" data-testid="film-set-conversion-settings-error">
      <span>{props.error}</span>{props.onRefreshModels ? <Button size="sm" tone="neutral" disabled={props.busy} onClick={props.onRefreshModels}>重新加载模型</Button> : null}
    </div> : null}
  </div>;
}
