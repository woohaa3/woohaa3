//! 导出格式与控制（I045）。
//!
//! 固定引擎的 `photocraft_io::export` 已能写多种扁平格式；本模块只把界面选择编译成
//! `EncodeOptions`，并把编码失败、警告与字节交回宿主端口。没有本机目录访问：字节仍走
//! 既有的单文件交付端口。

use crate::error::{EditorError,Result};
use serde_json::{Value,json};

/// 界面可选的扁平导出格式（都是固定编码器真实支持的）。
pub const FLAT_FORMATS: &[&str] = &["png", "jpeg", "webp", "tiff", "tga", "bmp", "gif", "ico"];

#[derive(Debug,Clone,PartialEq)]
pub struct ExportRequest {
    pub format: String,
    pub jpeg_quality: u8,
    pub jpeg_chroma_subsampling: bool,
    pub png_compression: String,
    pub png_interlaced: bool,
    pub webp_lossless: bool,
    pub webp_quality: u8,
    pub tiff_compression: String,
    pub embed_metadata: bool,
    pub scale: f64,
}

impl Default for ExportRequest {
    fn default() -> Self {
        Self { format:"png".into(), jpeg_quality:90, jpeg_chroma_subsampling:true, png_compression:"default".into(),
            png_interlaced:false, webp_lossless:false, webp_quality:85, tiff_compression:"lzw".into(), embed_metadata:true, scale:1.0 }
    }
}

fn bad(message:impl std::fmt::Display)->EditorError {EditorError::CommandFailed{id:"file.export".into(),message:message.to_string()}}

fn number(fields:&serde_json::Map<String,Value>,key:&str,min:f64,max:f64)->Result<Option<f64>> {
    match fields.get(key) {
        None=>Ok(None),
        Some(value)=>match value.as_f64() {
            Some(n) if n.is_finite() && n>=min && n<=max=>Ok(Some(n)),
            _=>Err(bad(format!("{key} 必须在 {min}–{max} 之间"))),
        }
    }
}

impl ExportRequest {
    /// 严格解析导出表单；未知字段与越界值在编码前拒绝。
    pub fn parse(params:&Value)->Result<Self> {
        let fields=params.as_object().ok_or_else(||bad("导出参数必须是对象"))?;
        let allowed=["format","jpegQuality","jpegChromaSubsampling","pngCompression","pngInterlaced",
            "webpLossless","webpQuality","tiffCompression","embedMetadata","scale"];
        if let Some(key)=fields.keys().find(|key|!allowed.contains(&key.as_str())) {return Err(bad(format!("导出包含未开放的参数：{key}")));}
        let mut request=Self::default();
        if let Some(format)=fields.get("format") {
            let format=format.as_str().ok_or_else(||bad("格式必须是字符串"))?;
            if !FLAT_FORMATS.contains(&format) {return Err(bad(format!("不支持的导出格式：{format}")));}
            request.format=format.into();
        }
        if let Some(value)=number(fields,"jpegQuality",1.0,100.0)? {request.jpeg_quality=value.round() as u8;}
        if let Some(value)=number(fields,"webpQuality",0.0,100.0)? {request.webp_quality=value.round() as u8;}
        if let Some(value)=number(fields,"scale",0.01,8.0)? {request.scale=value;}
        for key in ["jpegChromaSubsampling","pngInterlaced","webpLossless","embedMetadata"] {
            if fields.get(key).is_some_and(|value|!value.is_boolean()) {return Err(bad(format!("{key} 必须是布尔值")));}
        }
        if let Some(value)=fields.get("jpegChromaSubsampling") {request.jpeg_chroma_subsampling=value.as_bool().unwrap();}
        if let Some(value)=fields.get("pngInterlaced") {request.png_interlaced=value.as_bool().unwrap();}
        if let Some(value)=fields.get("webpLossless") {request.webp_lossless=value.as_bool().unwrap();}
        if let Some(value)=fields.get("embedMetadata") {request.embed_metadata=value.as_bool().unwrap();}
        if let Some(value)=fields.get("pngCompression") {
            let mode=value.as_str().ok_or_else(||bad("PNG 压缩必须是字符串"))?;
            if !["default","fast","best","none"].contains(&mode) {return Err(bad("PNG 压缩模式无效"));}
            request.png_compression=mode.into();
        }
        if let Some(value)=fields.get("tiffCompression") {
            let mode=value.as_str().ok_or_else(||bad("TIFF 压缩必须是字符串"))?;
            if !["none","lzw","deflate","packbits"].contains(&mode) {return Err(bad("TIFF 压缩模式无效"));}
            request.tiff_compression=mode.into();
        }
        Ok(request)
    }

    /// 交给固定编码器的选项；`scale` 由调用方先重采样文档。
    pub fn encode_options(&self)->photocraft_codecs::EncodeOptions {
        use photocraft_codecs::{PngCompression,TiffCompression};
        let mut options=photocraft_codecs::EncodeOptions::default();
        options.jpeg_quality=self.jpeg_quality;
        options.jpeg_chroma_subsampling=self.jpeg_chroma_subsampling;
        options.png_compression=match self.png_compression.as_str() {
            "fast"=>PngCompression::Fast, "best"=>PngCompression::Best, "none"=>PngCompression::None, _=>PngCompression::Default };
        options.png_interlaced=self.png_interlaced;
        options.webp_lossless=self.webp_lossless;
        options.webp_quality=self.webp_quality;
        options.tiff_compression=match self.tiff_compression.as_str() {
            "none"=>TiffCompression::None, "deflate"=>TiffCompression::Deflate, "packbits"=>TiffCompression::PackBits, _=>TiffCompression::Lzw };
        options.embed_metadata=self.embed_metadata;
        options
    }

    /// 导出扩展名（JPEG 同时接受 `.jpg`）。
    pub fn extension(&self)->&'static str {
        match self.format.as_str() { "jpeg"=>"jpg", "tiff"=>"tiff", other=>match other {"png"=>"png","webp"=>"webp","tga"=>"tga","bmp"=>"bmp","gif"=>"gif","ico"=>"ico",_=>"png"} }
    }

    /// 投影回界面，便于表单回填与回归。
    pub fn to_json(&self)->Value {
        json!({"format":self.format,"jpegQuality":self.jpeg_quality,"jpegChromaSubsampling":self.jpeg_chroma_subsampling,
            "pngCompression":self.png_compression,"pngInterlaced":self.png_interlaced,"webpLossless":self.webp_lossless,
            "webpQuality":self.webp_quality,"tiffCompression":self.tiff_compression,"embedMetadata":self.embed_metadata,"scale":self.scale})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_valid_and_round_trip() {
        let request=ExportRequest::parse(&json!({})).unwrap();
        assert_eq!(request,ExportRequest::default());
        assert_eq!(request.format,"png");
        assert_eq!(ExportRequest::parse(&request.to_json()).unwrap(),request);
    }

    #[test]
    fn formats_and_ranges_are_strict() {
        for format in FLAT_FORMATS {assert!(ExportRequest::parse(&json!({"format":format})).is_ok(),"{format} 应可导出");}
        for bad_request in [
            json!({"format":"psd"}),json!({"format":7}),json!({"jpegQuality":0}),json!({"jpegQuality":101}),
            json!({"webpQuality":-1}),json!({"scale":0}),json!({"scale":9}),json!({"pngCompression":"ultra"}),
            json!({"tiffCompression":"zip"}),json!({"jpegInterlaced":true}),json!({"embedMetadata":"yes"}),
        ] {
            assert!(ExportRequest::parse(&bad_request).is_err(),"必须拒绝：{bad_request}");
        }
    }

    #[test]
    fn extension_matches_the_chosen_format() {
        assert_eq!(ExportRequest::parse(&json!({"format":"jpeg"})).unwrap().extension(),"jpg");
        assert_eq!(ExportRequest::parse(&json!({"format":"webp"})).unwrap().extension(),"webp");
        assert_eq!(ExportRequest::parse(&json!({"format":"png"})).unwrap().extension(),"png");
        assert_eq!(ExportRequest::parse(&json!({"jpegQuality":75})).unwrap().encode_options().jpeg_quality,75);
    }
}
