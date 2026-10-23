//! 有界源像素预览；读取草稿或正式文档，不写修订、历史、选区与内容身份。
use photocraft_doc::{Document, LayerId};
use photocraft_geom::Rect;
use serde::Deserialize;
use serde_json::Value;
use crate::{Preview, error::{EditorError, Result}};

/// 单次最多 4 MiB RGBA8；视口由宿主分块调度，禁止一次读回整幅大图。
const MAX_REGION_SIDE: u32 = 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Region { x: u32, y: u32, width: u32, height: u32 }

fn region_rect(size: (u32,u32), params: Value) -> Result<Rect> {
    let invalid=||EditorError::RenderFailed("预览区域须为文档内的整数坐标，宽高为 1–1024 源像素".into());
    let r:Region=serde_json::from_value(params).map_err(|_|invalid())?;
    if r.width==0 || r.height==0 || r.width>MAX_REGION_SIDE || r.height>MAX_REGION_SIDE {
        return Err(invalid());
    }
    let right=r.x.checked_add(r.width).ok_or_else(invalid)?;
    let bottom=r.y.checked_add(r.height).ok_or_else(invalid)?;
    if right>size.0 || bottom>size.1 || right>i32::MAX as u32 || bottom>i32::MAX as u32 {
        return Err(invalid());
    }
    Ok(Rect::new(r.x as i32,r.y as i32,right as i32,bottom as i32))
}

pub(crate) fn render(doc:&Document, mask:Option<LayerId>, params:Value)->Result<Preview> {
    let rect=region_rect((doc.size.width,doc.size.height),params)?;
    let isolated=mask.map(|id|crate::layer_preview::isolated_document(doc,id,true)).transpose()?;
    let image=photocraft_compose::render(isolated.as_ref().unwrap_or(doc),rect).to_rgba8();
    Ok(Preview{width:image.width,height:image.height,pixels:image.pixels})
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn region_coordinates_are_source_pixels_without_thumbnail_scaling() {
        assert_eq!(region_rect((8000,6000),json!({"x":7000,"y":5000,"width":1000,"height":1000})).unwrap(),Rect::new(7000,5000,8000,6000));
        assert_eq!(region_rect((8000,6000),json!({"x":0,"y":0,"width":1024,"height":1})).unwrap(),Rect::new(0,0,1024,1));
    }

    #[test]
    fn malformed_outside_and_unbounded_requests_are_rejected_before_rendering() {
        for request in [
            Value::Null,json!([]),json!({"x":0,"y":0,"width":1}),
            json!({"x":-1,"y":0,"width":1,"height":1}),
            json!({"x":0.5,"y":0,"width":1,"height":1}),
            json!({"x":"1","y":0,"width":1,"height":1}),
            json!({"x":0,"y":0,"width":0,"height":1}),
            json!({"x":0,"y":0,"width":1025,"height":1}),
            json!({"x":0,"y":0,"width":1,"height":1025}),
            json!({"x":7999,"y":0,"width":2,"height":1}),
            json!({"x":0,"y":6000,"width":1,"height":1}),
            json!({"x":u32::MAX,"y":0,"width":1,"height":1}),
            json!({"x":0,"y":0,"width":1,"height":1,"target":"mask"}),
        ] {
            assert!(matches!(region_rect((8000,6000),request),Err(EditorError::RenderFailed(_))));
        }
        assert!(region_rect((u32::MAX,1),json!({"x":i32::MAX,"y":0,"width":1,"height":1})).is_err());
        assert!(region_rect((0,0),json!({"x":0,"y":0,"width":1,"height":1})).is_err());
    }
}
