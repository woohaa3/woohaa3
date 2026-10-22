/** 宿主先归一方向与色彩空间，再把 RGBA8 PNG 交给编辑内核。 */
export async function normalizeEditorImage(bytes: Uint8Array): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), { imageOrientation: "from-image", colorSpaceConversion: "default" });
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width > 8192 || bitmap.height > 8192 || bitmap.width * bitmap.height > 67_108_864) {
      throw new Error("图片超过编辑上限：单边最多 8192 像素，未缩小原图");
    }
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    try {
      const context = canvas.getContext("2d", { colorSpace: "srgb", alpha: true });
      if (!context) throw new Error("无法读取图片像素，请重试");
      context.drawImage(bitmap, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error("图片转换失败，请重试")), "image/png"));
      return new Uint8Array(await blob.arrayBuffer());
    } finally { canvas.width = 0; canvas.height = 0; }
  } finally { bitmap.close(); }
}
