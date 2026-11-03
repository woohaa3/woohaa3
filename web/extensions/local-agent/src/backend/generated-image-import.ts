/**
 * 目标回合收尾：生图后必须有成功的导入回执
 * （change: 2026-11-03-add-codex-image-import，D6）。
 */
export function generatedImageImportFailure(
  generatedCount: number,
  imported: boolean
): { code: "image-not-imported"; message: string } | null {
  if (generatedCount > 0 && !imported) {
    return {
      code: "image-not-imported",
      message: "已生成图片但未导入画布；请调用 import_generated_image 完成导入"
    };
  }
  return null;
}
