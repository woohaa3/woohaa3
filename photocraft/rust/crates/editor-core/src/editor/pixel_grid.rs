use super::*;
use photocraft_geom::Rect;
const MAX_PIXELS:u64=1_048_576;
const MAX_SEGMENTS:usize=60_000;

fn cell_color(rgba:[f32;4])->Option<[u8;4]> {
    let a=rgba[3];if !a.is_finite() || a<=0. {return None;}
    let a=a.min(1.);let luma=0.299*rgba[0]+0.587*rgba[1]+0.114*rgba[2];
    let shown=luma*a+0.9*(1.-a);let x=((shown-0.35)/0.4).clamp(0.,1.);
    let t=(x*x*(3.-2.*x)*8.).round()/8.;
    let white=0.25*a*(1.-t);let black=0.25*a*0.64*t;let total=white+black;
    let alpha=(total*255.).round() as u8;if alpha==0{return None;}
    let grey=(white/total*255.).round() as u8;Some([grey,grey,grey,alpha])
}
fn segments(px:&[[f32;4]],rect:Rect)->Vec<Value> {
    let w=rect.width() as usize;let h=rect.height() as usize;let mut out=Vec::new();
    for vertical in [true,false] {
        let (lines,len)=if vertical{(w,h)}else{(h,w)};
        for line in 0..lines {
            let mut open:Option<(usize,[u8;4])>=None;
            for i in 0..=len {
                let color=if i==len {None}else{let (x,y)=if vertical{(line,i)}else{(i,line)};cell_color(px[y*w+x])};
                if open.map(|(_,old)|Some(old)==color).unwrap_or(color.is_none()){continue;}
                if let Some((start,c))=open {
                    if out.len()==MAX_SEGMENTS{return out;}
                    let (x0,y0,x1,y1)=if vertical{(line,start,line,i)}else{(start,line,i,line)};
                    out.push(json!([rect.x0+x0 as i32,rect.y0+y0 as i32,rect.x0+x1 as i32,rect.y0+y1 as i32,c[0],c[1],c[2],c[3]]));
                }
                open=color.map(|color|(i,color));
            }
        }
    }
    out
}
impl Editor {
    /// Visible-region only, candidate-aware pixel edges. No document or history writes.
    pub fn pixel_grid(&self,params:Value)->Result<Value> {
        let fail=||EditorError::CommandFailed{id:"view.pixelGridReadout".into(),message:"像素网格区域无效或超出预算".into()};
        let fields=params.as_object().filter(|fields|fields.len()==4 && fields.keys().all(|key|["x","y","width","height"].contains(&key.as_str()))).ok_or_else(fail)?;
        let get=|key:&str|fields.get(key).and_then(Value::as_i64).and_then(|v|i32::try_from(v).ok()).ok_or_else(fail);
        let (x,y,w,h)=(get("x")?,get("y")?,get("width")?,get("height")?);
        if w<0 || h<0 || w as u64*h as u64>MAX_PIXELS || x.checked_add(w).is_none() || y.checked_add(h).is_none(){return Err(fail());}
        let doc=self.preview_document()?;
        let rect=Rect::new(x,y,x+w,y+h).intersect(&doc.bounds());
        if rect.is_empty(){return Ok(json!([]));}
        let pixels=photocraft_compose::render(doc,rect);
        Ok(Value::Array(segments(&pixels.px,rect)))
    }
}
#[cfg(test)]mod tests {
    use super::*;
    #[test]fn colors_match_native_shell_and_transparent_cells_skip(){
        assert_eq!(cell_color([0.,0.,0.,0.]),None);assert_eq!(cell_color([0.,0.,0.,0.001]),None);
        assert_eq!(cell_color([0.1,0.1,0.1,1.]),Some([255,255,255,64]));assert_eq!(cell_color([0.9,0.9,0.9,1.]),Some([0,0,0,41]));
        let lines=segments(&[[0.,0.,0.,1.],[0.;4],[0.,0.,0.,1.],[0.,0.,0.,1.]],Rect::new(0,0,2,2));
        assert_eq!(lines.len(),4);assert!(lines.contains(&json!([0,0,0,2,255,255,255,64])));
    }
    #[test]fn region_is_bounded_candidate_aware_and_read_only(){
        let mut editor=Editor::new();editor.execute("file.new",json!({"width":8,"height":6})).unwrap();editor.execute("layer.new.layer",json!({})).unwrap();
        for params in [json!({}),json!({"x":0,"y":0,"width":1025,"height":1024}),json!({"x":0,"y":0,"width":1.5,"height":1}),json!({"x":i32::MAX,"y":0,"width":1,"height":1})]{assert!(editor.pixel_grid(params).is_err());}
        let hash=editor.content_hash().unwrap();editor.begin_stroke(json!({"strokeCommand":"paint.pencil","points":[[4,5]],"size":1,"color":"#000000","smoothing":0})).unwrap();let state=editor.state();
        let lines=editor.pixel_grid(json!({"x":4,"y":5,"width":1,"height":1})).unwrap();assert_eq!(lines,json!([[4,5,4,6,255,255,255,64],[4,5,5,5,255,255,255,64]]));assert_eq!(editor.state(),state);assert_eq!(editor.content_hash().unwrap(),hash);editor.cancel_stroke();
        assert_eq!(editor.pixel_grid(json!({"x":100,"y":100,"width":1,"height":1})).unwrap(),json!([]));
    }
    #[test]fn lattice_has_a_hard_segment_budget(){let n=400;let px=(0..n*n).map(|i|if(i%n+i/n)%2==0{[0.,0.,0.,1.]}else{[0.;4]}).collect::<Vec<_>>();assert_eq!(segments(&px,Rect::new(0,0,n,n)).len(),MAX_SEGMENTS);}
}
