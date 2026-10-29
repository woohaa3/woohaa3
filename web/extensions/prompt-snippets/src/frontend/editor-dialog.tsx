/**
 * 片段编辑器 dialog renderer
 * （change: add-prompt-snippet-library，任务 5.1/5.2/5.3 / design D3/D5）。
 *
 * 名称、标签、正文（复用 mention editor + 片段局部 material key）与素材清单/预览。
 * 草稿归属本组件；保存成功关闭，失败保留草稿并显示安全错误；revision conflict 提供
 * 刷新或重新编辑入口（不 last-write-wins）。
 */
import { useMemo, useState } from "react";
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@woohaa3/ui/dialogs";
import { Button } from "@woohaa3/ui/primitives";
import type { DialogRendererProps } from "@woohaa3/frontend/extension-api";
import type { SnippetCatalog, MutationResult } from "./catalog.js";
import type { SnippetEditorPayload } from "./dialogs.js";
import type { PromptSnippetMaterial, PromptSnippet } from "@woohaa3/contracts";
import { MentionEditor } from "@woohaa3/frontend/extension-api";
import { candidateMentionOptions, syncSnippetMaterials } from "./sync-materials.js";
import type { MaterialCandidate } from "./materials.js";
import { useTagState } from "./use-catalog.js";
import { useMaterialPreviews, type MaterialPreviewStore } from "./preview.js";

export type EditorActions = {
  loadSnippet: (snippetId: string) => Promise<PromptSnippet | null>;
  saveCreate: (input: { name: string; body: string; materials: PromptSnippetMaterial[]; tagIds: string[] }) => Promise<MutationResult<PromptSnippet>>;
  saveUpdate: (input: { snippetId: string; expectedRevision: number; name: string; body: string; materials: PromptSnippetMaterial[]; tagIds: string[] }) => Promise<MutationResult<PromptSnippet>>;
};

export function createEditorRenderer(options: {
  catalog: SnippetCatalog;
  candidates: () => MaterialCandidate[];
  previews: MaterialPreviewStore;
  actions: EditorActions;
}) {
  return function EditorRenderer({ instance, requestClose }: DialogRendererProps) {
    const payload = instance.payload as SnippetEditorPayload;
    const tagState = useTagState(options.catalog);
    const [current, setCurrent] = useState<PromptSnippet | null>(null);
    const [name, setName] = useState(payload.draftName ?? "");
    const [body, setBody] = useState(payload.draftBody ?? "");
    const [tagIds, setTagIds] = useState<string[]>(payload.draftTagIds ?? []);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [conflict, setConflict] = useState(false);
    const [initialized, setInitialized] = useState(false);

    // 编辑模式：异步加载原片段（迟到结果以 mounted 语义忽略）。
    if (payload.mode === "edit" && payload.snippetId && !initialized) {
      setInitialized(true);
      void options.actions.loadSnippet(payload.snippetId).then((snippet) => {
        if (!snippet) return;
        setCurrent(snippet);
        setName(snippet.name);
        setBody(snippet.body);
        setTagIds(snippet.tagIds);
      });
    }

    const candidates = options.candidates();
    const mentionOptions = useMemo(() => candidateMentionOptions(candidates), [candidates]);
    const synced = useMemo(
      () => syncSnippetMaterials({ body, materials: current?.materials ?? [], candidates }),
      [body, current, candidates]
    );
    const materialPreview = useMaterialPreviews(options.previews, synced.materials);

    const canSave = name.trim() !== "" && body.trim() !== "" && synced.missingKeys.length === 0 && !saving;

    const save = async () => {
      setSaving(true);
      setError(null);
      setConflict(false);
      const result =
        payload.mode === "edit" && current
          ? await options.actions.saveUpdate({
              snippetId: current.id,
              expectedRevision: current.revision,
              name,
              body,
              materials: synced.materials,
              tagIds
            })
          : await options.actions.saveCreate({ name, body, materials: synced.materials, tagIds });
      setSaving(false);
      if (result.ok) {
        requestClose();
        return;
      }
      if (result.code === "SNIPPET_REVISION_CONFLICT") setConflict(true);
      setError(result.error);
    };

    return (
      <Dialog.Content
        variant="standard"
        size="lg"
        busy={saving}
        labelledBy={`${instance.instanceId}-title`}
        instanceId={instance.instanceId}
        onOverlayClick={saving ? undefined : requestClose}
      >
        <DialogHeader onClose={saving ? undefined : requestClose}>
          <DialogTitle id={`${instance.instanceId}-title`}>{payload.mode === "edit" ? "编辑片段" : "新建片段"}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <label className="snippet-editor__field">
            名称
            <input type="text" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
          </label>
          <div className="snippet-editor__field">
            <span>标签</span>
            <div role="group" aria-label="标签">
              {tagState.items.map((tag) => (
                <label key={tag.id}>
                  <input
                    type="checkbox"
                    checked={tagIds.includes(tag.id)}
                    onChange={(event) =>
                      setTagIds(
                        event.target.checked ? [...tagIds, tag.id] : tagIds.filter((id) => id !== tag.id)
                      )
                    }
                  />
                  {tag.name}
                </label>
              ))}
            </div>
          </div>
          <div className="snippet-editor__field">
            <span>正文</span>
            <MentionEditor value={body} onChange={setBody} candidates={mentionOptions} ariaLabel="片段正文" />
          </div>
          <div className="snippet-editor__materials" aria-label="引用素材">
            {synced.materials.map((material) => (
              <div key={material.key} className="snippet-editor__material" data-media-kind={material.mediaKind}>
                <span>{material.label}</span>
                <span className="snippet-editor__material-kind">{material.mediaKind}</span>
                {materialPreview.get(material.key)?.status === "ready" && materialPreview.get(material.key)?.url ? (
                  material.mediaKind === "image" ? (
                    <img src={materialPreview.get(material.key)!.url!} alt={material.label} width={48} height={48} />
                  ) : (
                    <span>可预览</span>
                  )
                ) : (
                  <span>{materialPreview.get(material.key)?.status ?? "unknown"}</span>
                )}
              </div>
            ))}
            {synced.missingKeys.length > 0 ? (
              <p role="alert">有 {synced.missingKeys.length} 个素材引用无法解析，请移除对应 mention 后保存。</p>
            ) : null}
          </div>
          {conflict ? (
            <div role="alert" className="dlg__error">
              片段已被他人修改。
              <Button
                size="sm"
                onClick={() => {
                  if (!current) return;
                  void options.actions.loadSnippet(current.id).then((snippet) => {
                    if (snippet) setCurrent(snippet);
                  });
                }}
              >
                刷新
              </Button>
            </div>
          ) : null}
          {error && !conflict ? (
            <p className="dlg__error" role="alert">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button onClick={requestClose} disabled={saving}>
            取消
          </Button>
          <Button tone="primary" onClick={() => void save()} disabled={!canSave}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </Dialog.Content>
    );
  };
}
