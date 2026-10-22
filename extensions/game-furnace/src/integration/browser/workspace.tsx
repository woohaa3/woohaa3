import { useMemo } from "react";
import { Button } from "@woohaa3/frontend/extension-api";
import { GAME_FURNACE_LABEL } from "../../state/shared/index.js";
import { createGameFurnaceRemote } from "./remote.js";
import { generationPhase } from "../../state/browser/workspace-session.js";
import { GameFurnaceMaterialsPanel } from "../../authoring/browser/materials-panel.js";
import { GameFurnacePreviewPanel } from "../../preview/browser/preview-panel.js";
import { useGameFurnacePreview } from "../../preview/browser/use-preview.js";
import { GameFurnaceRequirementsPanel } from "../../authoring/browser/requirements-panel.js";
import "./workspace.css";
import type { GameFurnaceWorkspaceProps } from "../../state/browser/workspace-props.js";
import { useGameFurnaceAuthoring } from "../../authoring/browser/use-workspace.js";
import { ResourcePreview } from "../../preview/browser/resource-preview.js";

export type { GameFurnaceWorkspaceProps } from "../../state/browser/workspace-props.js";
export function GameFurnaceWorkspace(props: GameFurnaceWorkspaceProps) {
 const client = useMemo(() => createGameFurnaceRemote({ transport: props.remote.transport }), [props.remote]);
 const { nodeId, currentCanvas, preview, view, resourceDraft, dirtyResources, resourceConflictList, editable, busy, mediaRemote, setResourceDraft, saveResources, collect, selectedModel, writable, commands, setDraft, save, generate, cancel, finalize, activate, taskPhase, message } = useGameFurnaceAuthoring({ ...props, client, usePreview: useGameFurnacePreview });
  if (!nodeId) return null;

  const phase = taskPhase ?? generationPhase(view);

  return (
    <div className="game-furnace-workspace" data-game-furnace-workspace="true">
      <header className="game-furnace-workspace__header">
        <Button size="sm" onClick={() => { preview.stop(); props.onBack(); }}>返回画布</Button>
        <strong>{GAME_FURNACE_LABEL}</strong>
        <span data-game-furnace-saved={view.saved ? "true" : "false"}>{view.saved ? "已保存" : "未保存"}</span>
        {!writable ? <span role="status">只读</span> : null}
      </header>

      {preview.buildId !== null ? (
        <GameFurnacePreviewPanel
          panelRef={preview.panelRef}
          frameRef={preview.frameRef}
          title={view.builds.find(build => build.buildId === preview.buildId)?.title ?? "游戏试玩"}
          frameKey={preview.frameKey}
          error={preview.error}
          loaded={preview.loaded}
          url={preview.url}
          html={preview.html}
          bridgeNonce={preview.bridge?.nonce ?? ""}
          bridgeGeneration={preview.bridge?.generation ?? preview.frameKey}
          onStop={preview.stop}
          onRetry={() => void preview.play(preview.buildId!)}
          onLoaded={preview.markLoaded}
        />
      ) : (
      <div className="game-furnace-workspace__body">
        <GameFurnaceMaterialsPanel
          renderResourcePreview={resource => <ResourcePreview key={resource.metadata?.storageKey ?? resource.resourceId} resource={resource} />}
          resources={view.resources}
          resourceDraft={resourceDraft}
          dirtyResources={dirtyResources}
          conflicts={resourceConflictList}
          editable={editable}
          busy={busy !== null}
          mediaRemote={mediaRemote}
          onResourceDraftChange={setResourceDraft}
          onSaveResources={saveResources}
          onCollect={collect}
        />

        <GameFurnaceRequirementsPanel
          canvasId={currentCanvas?.id}
          nodeId={nodeId}
          requirements={view.requirements}
          builds={view.builds}
          generations={view.generations}
          {...(view.activeBuildId ? { activeBuildId: view.activeBuildId } : {})}
          {...(view.latestGenerationId ? { latestGenerationId: view.latestGenerationId } : {})}
          dirtyFields={view.dirtyFields}
          canGenerate={view.canGenerate}
          editable={editable}
          busy={busy !== null}
          phase={phase}
          model={selectedModel}
          guideWritable={writable && commands.isWritable()}
          onDraftChange={(field, value) => setDraft((previous) => ({ ...previous, [field]: value }))}
          onConfigureModels={() => { preview.stop(); props.onConfigureModels(); }}
          onSave={save}
          onGenerate={generate}
          onCancel={cancel}
          onFinalize={finalize}
          onPlay={preview.play}
          onActivate={activate}
        />
      </div>
      )}

      {busy ? <p role="status">处理中…</p> : null}
      {message ? <p role="status" className="game-furnace-workspace__message">{message}</p> : null}

    </div>
  );
}
