/** 创建弹窗使用应用 Dialog Host；不再锚定节点，也不显示视频范围。 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { agentDirectory, type DialogRendererProps, type DialogsService } from "@woohaa3/frontend/extension-api";
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@woohaa3/ui/dialogs";
import { FilmIcon, ImageIcon } from "@woohaa3/ui/icons";
import type { FilmSetConversionSourceKind } from "@woohaa3/contracts";
import { defaultFilmSetConversionEntry } from "./controller.js";
import { FilmSetConversionSettingsPanel, type FilmSetConversionActionDependencies } from "./action.js";
import { resolveFilmSetConversionAvailability } from "./view.js";

export const FILM_SET_CREATION_DIALOG_ID = "film-set-creation";
export type FilmSetCreationPayload = { nodeId: string; nodeType: string };

export function createFilmSetConversionSettings(deps: FilmSetConversionActionDependencies) {
  return function FilmSetConversionSettings({ nodeId, nodeType, writable, onClose, setBusy }: {
    nodeId: string; nodeType: string; writable: boolean; onClose: () => void; setBusy?: (busy: boolean) => void;
  }) {
    const canvas = useSyncExternalStore(deps.subscribeCanvas, deps.getCanvas, () => null);
    const snapshot = useSyncExternalStore(deps.controller.subscribe, deps.controller.getSnapshot, deps.controller.getSnapshot);
    const entry = snapshot.entries.get(nodeId) ?? defaultFilmSetConversionEntry(nodeId, nodeType, deps.preferences.read());
    const availability = resolveFilmSetConversionAvailability({ canvas, nodeId, nodeType, writable });
    const kind = nodeType as FilmSetConversionSourceKind;
    const models = entry.models.filter(model => model.supports.includes(kind));
    const data = canvas?.nodeData[nodeId];
    const asset = canvas?.assets.find(asset => asset.id === data?.outputAssetId);
    useEffect(() => {
      if (!deps.controller.getSnapshot().entries.get(nodeId)?.settingsOpen) deps.controller.openSettings({ nodeId, nodeType });
      return () => { deps.controller.closeSettings({ nodeId, nodeType }); };
    }, [nodeId, nodeType]);
    const close = useCallback(() => {
      if (entry.busy) return;
      deps.controller.closeSettings({ nodeId, nodeType }); onClose();
    }, [nodeId, nodeType, entry.busy, onClose]);
    return <Dialog.Content ariaLabel="创建片场" size="md" busy={entry.busy} onOverlayClick={close}>
      <DialogHeader onClose={entry.busy ? undefined : close}><DialogTitle>创建片场</DialogTitle></DialogHeader>
      <DialogBody className="film-set-creation-dialog" >
        <div className="film-set-creation-dialog__source">
          {kind === "image" && asset?.url ? <img src={asset.url} alt="" /> : <span>{kind === "image" ? <ImageIcon /> : <FilmIcon />}</span>}
          <span>{asset?.title || (kind === "video" ? "视频素材" : "图片素材")}</span>
        </div>
        {entry.pending ? <button type="button" disabled={entry.busy} onClick={() => { void deps.controller.queryCreation({ nodeId }).then(accepted => { if (accepted) onClose(); }); }}>核对原请求</button> : null}
        <FilmSetConversionSettingsPanel kind={kind} models={models} modelsLoaded={entry.modelsLoaded}
          assistant={deps.assistant}
          draft={entry.draft} disabled={!availability.available} busy={entry.busy}
          needsConfiguration={entry.modelsLoaded && models.length === 0} error={entry.error || (availability.available ? null : availability.reason)}
          {...(deps.openConnectChatGpt ? { openConnectChatGpt: deps.openConnectChatGpt } : {})}
          {...(deps.openConfigureModel ? { openConfigureModel: deps.openConfigureModel } : {})}
          onRefreshModels={() => { void deps.controller.refreshModels({ nodeId, nodeType }); if (deps.assistant) void agentDirectory(deps.assistant, deps.assistant.getDataScopeId?.() ?? "page").load(true); }}
          onDraftChange={draft => deps.controller.setDraft({ nodeId, nodeType, draft })}
          onStart={() => { void (async () => {
            setBusy?.(true);
            const accepted = await deps.controller.startFromSettings({ nodeId, nodeType });
            setBusy?.(false);
            if (accepted) onClose();
          })(); }} />
      </DialogBody>
    </Dialog.Content>;
  };
}

export function createFilmSetConversionDialog(deps: FilmSetConversionActionDependencies, dialogs: DialogsService) {
  const Settings = createFilmSetConversionSettings(deps);
  return function FilmSetConversionDialog({ instance, requestClose, setBusy }: DialogRendererProps) {
    const payload = instance.payload as FilmSetCreationPayload;
    // 配置弹窗关闭回到创建弹窗时，重新读取模型目录，同时保留当前草稿。
    useEffect(() => {
      let wasTop = dialogs.top()?.instanceId === instance.instanceId;
      return dialogs.subscribe(() => {
        const isTop = dialogs.top()?.instanceId === instance.instanceId;
        if (isTop && !wasTop) {
          void deps.controller.refreshModels(payload);
          if (deps.assistant) void agentDirectory(deps.assistant, deps.assistant.getDataScopeId?.() ?? "page").load(true);
        }
        wasTop = isTop;
      });
    }, [instance.instanceId, payload.nodeId, payload.nodeType]);
    return <Settings key={payload.nodeId} {...payload} writable={deps.controller.state.isWritable()} onClose={requestClose} setBusy={setBusy} />;
  };
}
