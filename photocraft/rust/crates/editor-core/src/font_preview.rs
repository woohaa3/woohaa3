//! Read-only samples from the same bundled native fonts used by Type; never browser fallback.
use photocraft_doc::{PixelFormat,TextLayer};
use photocraft_geom::{Affine,Rect};
use crate::{Editor,Preview,error::{EditorError,Result}};

impl Editor {
    pub fn font_preview(&self,family:&str,size:u32,scale:u32)->Result<Preview>{
        let fail=|message:&str|EditorError::CommandFailed{id:"text.fontPreview".into(),message:message.into()};
        if !matches!(family,"Inter"|"Noto Sans SC") || ![14,18,24,32,40].contains(&size) || !(1..=4).contains(&scale){return Err(fail("字体样例参数无效"));}
        let mut engine=photocraft_text::shared().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if !engine.fonts.has_family(family){return Err(fail("样例字体尚未加载"));}
        let width=(100.0*size as f64/18.0).round() as u32*scale;
        let height=(24.0*size as f64/18.0).round() as u32*scale;
        let layer=TextLayer{text:"AaBbCc".into(),font_family:family.into(),size_pt:(size*scale) as f32,..Default::default()};
        let layout=engine.layout(&layer,72.0);
        let bounds=layout.bounds().ok_or_else(||fail("字体样例没有可显示字形"))?;
        let transform=Affine::translate(f64::from(-bounds[0]),f64::from((height as f32-(bounds[3]-bounds[1]))/2.0-bounds[1]));
        let ink=photocraft_text::render::ink_rect(&layout,&transform);
        if ink.is_empty() || ink.width()>width*4 || ink.height()>height*4{return Err(fail("字体样例超过资源上限"));}
        let raster=photocraft_text::render::rasterize(&layout,&transform,PixelFormat::RGBA8,layer.antialias);
        let mut rgba=vec![[0u8;4];(width*height) as usize];
        raster.surface.read_rgba8_into(Rect::new(0,0,width as i32,height as i32),&mut rgba);
        Ok(Preview{width,height,pixels:rgba.into_iter().flat_map(|pixel|[255,255,255,pixel[3]]).collect()})
    }
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn bundled_font_samples_are_bounded_and_do_not_create_a_document(){
        let editor=Editor::new();let before=editor.state();
        for size in [14,18,24,32,40]{for scale in [1,2,4]{let preview=editor.font_preview("Inter",size,scale).unwrap();assert_eq!(preview.pixels.len(),(preview.width*preview.height*4) as usize);assert!(preview.width<=888 && preview.height<=212);assert!(preview.pixels.chunks_exact(4).any(|pixel|pixel[3]>0));}}
        for (font,size,scale) in [("missing",18,1),("Inter",0,1),("Inter",41,1),("Inter",18,0),("Inter",18,5)]{assert!(editor.font_preview(font,size,scale).is_err());}
        assert_eq!(editor.state(),before);
    }
}
