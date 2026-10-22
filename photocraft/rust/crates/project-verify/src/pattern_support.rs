//! 工程内图案的资源边界；不采样、合成或生成图像。
use std::collections::HashSet;
use photocraft_doc::{Pattern,ColorMode,SampleType};
use photocraft_format::manifest::PatternM;
use crate::limits::{MAX_PATTERNS,MAX_PATTERN_SIDE,MAX_PATTERN_PIXELS};

fn metadata(id:&str,name:&str,width:u32,height:u32,ids:&mut HashSet<String>,pixels:&mut u64)->bool {
    *pixels=pixels.saturating_add(u64::from(width)*u64::from(height));
    !id.trim().is_empty() && id.encode_utf16().count()<=200 && !name.trim().is_empty() && name.encode_utf16().count()<=200
        && width>0 && height>0 && width<=MAX_PATTERN_SIDE && height<=MAX_PATTERN_SIDE
        && *pixels<=MAX_PATTERN_PIXELS && ids.insert(id.to_string())
}
fn coordinates(mut coords:impl Iterator<Item=(i32,i32)>,width:u32,height:u32)->bool {
    let mut seen=HashSet::new();
    coords.all(|(x,y)| x>=0 && y>=0 && (x as u32)<width.div_ceil(256)
        && (y as u32)<height.div_ceil(256) && seen.insert((x,y)))
}
/// 必须在解码图案 tile 前核验尺寸、数量、格式与 tile 范围。
pub fn supported_manifest(patterns:&[PatternM])->bool {
    if patterns.len()>MAX_PATTERNS {return false;}
    let (mut ids,mut pixels)=(HashSet::new(),0);
    patterns.iter().all(|p| {
        let f=p.surface.format;
        metadata(&p.id,&p.name,p.width,p.height,&mut ids,&mut pixels)
            && f.mode==ColorMode::Rgb && f.sample==SampleType::U8
            && p.surface.default.len()==f.bytes_per_pixel()*2 && p.surface.default.bytes().all(|b|b.is_ascii_hexdigit())
            && p.surface.tiles.len()<=16 && coordinates(p.surface.tiles.iter().map(|t|(t.tx,t.ty)),p.width,p.height)
    })
}
pub fn supported(patterns:&[Pattern])->bool {
    if patterns.len()>MAX_PATTERNS {return false;}
    let (mut ids,mut pixels)=(HashSet::new(),0);
    patterns.iter().all(|p| {
        let f=p.surface.format();
        metadata(&p.id,&p.name,p.width,p.height,&mut ids,&mut pixels)
            && f.mode==ColorMode::Rgb && f.sample==SampleType::U8 && p.surface.tile_count()<=16
            && coordinates(p.surface.tiles().map(|(c,_)|(c.tx,c.ty)),p.width,p.height)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use photocraft_doc::{Document,Size,Surface};
    fn pattern(id:&str)->Pattern {
        let f=Document::new("test",Size::new(1,1),ColorMode::Rgb,SampleType::U8).pixel_format();
        Pattern{id:id.into(),name:"图案".into(),width:16,height:16,surface:Surface::new(f)}
    }
    #[test]
    fn bounds_identity_format_and_sparse_coordinates_without_pixels() {
        let p=pattern("one");assert!(supported(&[p.clone()]));
        assert!(!supported(&[p.clone(),p.clone()]));
        let mut bad=p.clone();bad.width=0;assert!(!supported(&[bad]));
        let mut bad=p.clone();bad.width=1025;assert!(!supported(&[bad]));
        let mut bad=p.clone();bad.id=" ".into();assert!(!supported(&[bad]));
        let mut bad=p.clone();bad.name="a".repeat(201);assert!(!supported(&[bad]));
        let mut bad=p;bad.surface=Surface::new(Document::new("t",Size::new(1,1),ColorMode::Grayscale,SampleType::U8).pixel_format());assert!(!supported(&[bad]));
        assert!(!supported(&(0..65).map(|i|pattern(&i.to_string())).collect::<Vec<_>>()));
        let all:Vec<_>=(0..5).map(|i|Pattern{width:1024,height:1024,..pattern(&i.to_string())}).collect();assert!(!supported(&all));
        assert!(coordinates([(0,0),(1,1)].into_iter(),512,512));
        assert!(!coordinates([(0,0),(0,0)].into_iter(),512,512));
        assert!(!coordinates([(-1,0)].into_iter(),512,512));
        assert!(!coordinates([(1,0)].into_iter(),256,256));
    }
}
