import {expect,it} from "vitest";
import {decodeExportOptions} from "./export-dialog.js";
import {DEFAULT_EXPORT_OPTIONS,EXPORT_FORMATS} from "./ports.js";

it("八种扁平格式都有真实的扩展名与 MIME",()=>{
  expect(Object.keys(EXPORT_FORMATS).sort()).toEqual(["bmp","gif","ico","jpeg","png","tga","tiff","webp"]);
  expect(EXPORT_FORMATS.jpeg).toEqual({label:"JPEG",extension:"jpg",contentType:"image/jpeg"});
  expect(EXPORT_FORMATS.webp.contentType).toBe("image/webp");
  expect(DEFAULT_EXPORT_OPTIONS.format).toBe("png");
  expect(DEFAULT_EXPORT_OPTIONS.scale).toBe(1);
});

it("严格解码导出选项：未知格式返回 null，越界值回退默认",()=>{
  expect(decodeExportOptions(DEFAULT_EXPORT_OPTIONS)).toEqual(DEFAULT_EXPORT_OPTIONS);
  expect(decodeExportOptions(null)).toBeNull();
  expect(decodeExportOptions({format:"psd"})).toBeNull();
  expect(decodeExportOptions({format:"png",jpegQuality:0})?.jpegQuality).toBe(DEFAULT_EXPORT_OPTIONS.jpegQuality);
  expect(decodeExportOptions({format:"jpeg",scale:20})?.scale).toBe(1);
  expect(decodeExportOptions({format:"png",pngCompression:"ultra"})?.pngCompression).toBe("default");
  expect(decodeExportOptions({format:"tiff",tiffCompression:"zip"})?.tiffCompression).toBe("lzw");
  expect(decodeExportOptions({format:"png",embedMetadata:"yes"})?.embedMetadata).toBe(true);
  expect(decodeExportOptions({format:"gif",scale:0.5})?.scale).toBe(0.5);
});
