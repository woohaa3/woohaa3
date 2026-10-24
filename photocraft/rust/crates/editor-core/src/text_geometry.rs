//! 文字输入覆盖层的只读几何。字节偏移与 DOM UTF-16 偏移只在边界转换。
use photocraft_geom::{Affine, Point};
use photocraft_text::TextLayout;
use serde_json::{Value, json};
use crate::{error::Result, text_preview::error};

pub(crate) struct Request {
    pub start: usize,
    pub end: usize,
    pub hit: Option<[f64; 2]>,
    pub movement: Option<String>,
    pub unit: Option<String>,
}

/// 在布局前校验，拒绝利用查询参数修改图层或开放其他文字能力。
pub(crate) fn request(value: &Value, text: &str) -> Result<Request> {
    let params=value.as_object().ok_or_else(||error("文字几何参数必须是对象"))?;
    if params.keys().any(|key|!matches!(key.as_str(),"start"|"end"|"hit"|"move"|"unit")) {
        return Err(error("文字几何包含未开放的参数"));
    }
    let index=|key:&str| -> Result<usize> {
        let index=params.get(key).and_then(Value::as_u64)
            .and_then(|n|usize::try_from(n).ok()).ok_or_else(||error("文字选择位置必须是 UTF-16 整数偏移"))?;
        utf16_to_byte(text,index).ok_or_else(||error("文字选择位置超出范围或位于代理项中间"))
    };
    let start=index("start")?;
    let end=index("end")?;
    let hit=if let Some(value)=params.get("hit") {
        let values=value.as_array().filter(|v|v.len()==2).ok_or_else(||error("文字命中需要两个文档坐标"))?;
        let coord=|value:&Value|value.as_f64().filter(|n|n.is_finite() && n.abs()<=1_000_000.0)
            .ok_or_else(||error("文字命中坐标无效"));
        Some([coord(&values[0])?,coord(&values[1])?])
    } else { None };
    let movement=if let Some(value)=params.get("move") {
        Some(value.as_str().filter(|v|matches!(*v,"linePrev"|"lineNext"|"lineStart"|"lineEnd"|"wordPrev"|"wordNext"|"charPrev"|"charNext"))
            .ok_or_else(||error("文字导航动作无效"))?.to_string())
    } else {None};
    let unit=params.get("unit").map(|value|value.as_str().filter(|value|matches!(*value,"word"|"line"|"paragraph"|"all")).map(str::to_owned).ok_or_else(||error("文字选择单位无效"))).transpose()?;
    if unit.is_some() && hit.is_none() {return Err(error("文字多击选择需要命中坐标"));}
    Ok(Request{start,end,hit,movement,unit})
}

fn utf16_to_byte(text: &str, offset: usize) -> Option<usize> {
    let mut at=0;
    for (byte,ch) in text.char_indices() {
        if at==offset {return Some(byte)}
        at+=ch.len_utf16();
        if at>offset {return None}
    }
    (at==offset).then_some(text.len())
}

fn utf16_offset(text: &str, byte: usize) -> usize {
    // 上游返回合法字节边界；防止异常布局导致字符串切片 panic。
    let mut byte=byte.min(text.len());
    while !text.is_char_boundary(byte) {byte-=1;}
    text[..byte].encode_utf16().count()
}

pub(crate) fn project(layout: &TextLayout, text: &str, transform: Affine, request: Request) -> Result<Value> {
    if !transform.m.iter().all(|n|n.is_finite()) {return Err(error("文字变换无效"))}
    let inverse=transform.inverse().ok_or_else(||error("文字变换不可逆，无法定位输入"))?;
    let point=|p:(f32,f32)| -> [f64;2] {
        let p=transform.apply(Point::new(f64::from(p.0),f64::from(p.1)));
        [p.x,p.y]
    };
    let caret=layout.caret_segment(request.end).map(point);
    let (start,end)=(request.start.min(request.end),request.start.max(request.end));
    // 按字形簇投影，保留 RTL 和旋转后的四边形，不用浏览器重新测量字宽。
    let selection:Vec<_>=layout.clusters.iter().filter(|c|c.range.start<end && c.range.end>start)
        .filter_map(|c|layout.lines.get(c.line).map(|line| {
            let (left,right)=(c.x,c.x+c.advance);
            let (top,bottom)=(line.baseline-line.ascent,line.baseline+line.descent);
            [(left,top),(right,top),(right,bottom),(left,bottom)].map(|(x,y)|point(layout.to_text(x,y)))
        })).collect();
    let hit=request.hit.map(|[x,y]| {
        let p=inverse.apply(Point::new(x,y));
        utf16_offset(text,layout.hit_test(p.x as f32,p.y as f32))
    });
    let mut out=json!({"caret":caret,"selection":selection,"hit":hit});
    if let (Some(unit),Some([x,y]))=(request.unit.as_deref(),request.hit) {
        let p=inverse.apply(Point::new(x,y));let byte=layout.hit_test(p.x as f32,p.y as f32);
        let (a,b)=click_range(layout,text,byte,layout.to_line(p.x as f32,p.y as f32).1,unit);
        out["range"]=json!([utf16_offset(text,a),utf16_offset(text,b)]);
    }
    if let Some([x0,y0,x1,y1])=layout.bounds() {out["frame"]=json!([(x0,y0),(x1,y0),(x1,y1),(x0,y1)].map(point));}
    if let Some(movement)=request.movement.as_deref() {
        let index=text[..request.end].chars().count();
        let next=match movement {
            "charPrev"|"charNext" => {
                let forward=movement=="charNext";
                let stops=layout.clusters.iter().flat_map(|c|[c.range.start,c.range.end]).chain(layout.lines.iter().flat_map(|line|[line.range.start,line.range.end])).chain([0,text.len()]);
                let byte=if forward{stops.filter(|b|*b>request.end).min().unwrap_or(text.len())}else{stops.filter(|b|*b<request.end).max().unwrap_or(0)};
                text[..byte].chars().count()
            }
            "wordPrev"|"wordNext" => photocraft_text::word_boundary(text,index,movement=="wordNext"),
            "lineStart"|"lineEnd" => photocraft_text::line_edge(layout,text,index,movement=="lineEnd"),
            _ => {
                let (x,_,_)=layout.caret(request.end);
                photocraft_text::line_step(layout,text,index,x,if movement=="linePrev" {-1} else {1})
            }
        };
        out["next"]=json!(utf16_offset(text,photocraft_text::byte_index(text,next)));
    }
    Ok(out)
}

fn click_range(layout:&TextLayout,text:&str,byte:usize,y:f32,unit:&str)->(usize,usize) {
    let byte=byte.min(text.len());
    match unit {
        "all"=>(0,text.len()),
        "word"=>{
            let mut a=byte;let mut b=byte;
            for (i,ch) in text[..byte].char_indices().rev() {if !ch.is_alphanumeric() {break;}a=i;}
            for ch in text[byte..].chars() {if !ch.is_alphanumeric() {break;}b+=ch.len_utf8();}
            (a,b)
        }
        "line"=>layout.lines.iter().min_by(|a,b|{
            let distance=|line:&photocraft_text::layout::LineInfo|if y<line.baseline-line.ascent {line.baseline-line.ascent-y} else if y>line.baseline+line.descent {y-line.baseline-line.descent} else {0.};distance(a).total_cmp(&distance(b))
        }).map(|line|(line.range.start,line.range.end)).unwrap_or((byte,byte)),
        _=>{
            let paragraphs=photocraft_text::layout::split_paragraphs(text);
            paragraphs.iter().find(|range|byte>=range.start && byte<range.end).or_else(||paragraphs.last()).map(|range|{
                let body=text.get(range.clone()).unwrap_or("").trim_end_matches(['\r','\n']);(range.start,range.start+body.len())
            }).unwrap_or((byte,byte))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use photocraft_text::layout::{ClusterInfo,LineInfo};

    #[test]
    fn utf16_indices_reject_split_surrogates_and_out_of_range_before_layout() {
        let text="中😀a";
        for (offset,byte) in [(0,0),(1,3),(3,7),(4,8)] {
            assert_eq!(utf16_to_byte(text,offset),Some(byte));
            assert_eq!(utf16_offset(text,byte),offset);
        }
        for value in [json!({"start":2,"end":3}),json!({"start":0,"end":5}),json!({"start":0.5,"end":0}),
            json!({"start":0,"end":0,"layer":1}),json!({"start":0,"end":0,"hit":[1]}),json!({"start":0,"end":0,"hit":[1e20,2]}),
            json!({"start":0,"end":0,"move":"unknown"})] {
            assert!(request(&value,text).is_err(),"{value}");
        }
    }

    fn layout() -> TextLayout {
        // 仅构造领域布局，不调用排版、字形栅格化或图像渲染。
        TextLayout{lines:vec![LineInfo{range:0..8,baseline:12.0,x0:0.0,x1:30.0,ascent:10.0,descent:3.0,paragraph:0}],
            clusters:vec![ClusterInfo{range:0..3,x:0.0,advance:10.0,line:0,rtl:false},
                ClusterInfo{range:3..7,x:10.0,advance:12.0,line:0,rtl:false},
                ClusterInfo{range:7..8,x:22.0,advance:8.0,line:0,rtl:true}],..Default::default()}
    }

    #[test]
    fn caret_hit_and_selection_use_native_clusters_under_affine_transform() {
        let text="中😀a";
        let transform=Affine{m:[0.0,2.0,-3.0,0.0,100.0,50.0]};
        let query=request(&json!({"start":1,"end":3,"hit":[79,72]}),text).unwrap();
        let value=project(&layout(),text,transform,query).unwrap();
        assert_eq!(value["hit"],1);
        let word=request(&json!({"start":0,"end":0,"hit":[79,72],"unit":"word"}),text).unwrap();
        assert_eq!(project(&layout(),text,transform,word).unwrap()["range"],json!([0,1]));
        let line=request(&json!({"start":0,"end":0,"hit":[79,72],"unit":"line"}),text).unwrap();
        assert_eq!(project(&layout(),text,transform,line).unwrap()["range"],json!([0,4]));
        assert_eq!(value["frame"],json!([[94.0,50.0],[94.0,110.0],[55.0,110.0],[55.0,50.0]]));
        // RTL 簇起点位于其右侧 (x=30)，不是下一字符的逻辑 x=22。
        assert_eq!(value["caret"],json!([[94.0,110.0],[55.0,110.0]]));
        assert_eq!(value["selection"],json!([[[94.0,70.0],[94.0,94.0],[55.0,94.0],[55.0,70.0]]]));
        let reverse=request(&json!({"start":3,"end":1}),text).unwrap();
        assert_eq!(project(&layout(),text,transform,reverse).unwrap()["selection"],value["selection"]);
        let collapsed=request(&json!({"start":0,"end":0}),text).unwrap();
        assert_eq!(project(&layout(),text,transform,collapsed).unwrap()["selection"],json!([]));
        let singular=Affine{m:[0.0;6]};
        assert!(project(&layout(),text,singular,request(&json!({"start":0,"end":0}),text).unwrap()).is_err());
    }

    #[test]
    fn navigation_reuses_native_soft_wrap_lines_and_returns_utf16_offsets() {
        let text="中😀a";
        let mut layout=layout();
        layout.lines[0].range=0..3;
        layout.lines.push(LineInfo{range:3..8,baseline:30.0,x0:0.0,x1:20.0,ascent:10.0,descent:3.0,paragraph:0});
        layout.clusters[1].line=1;layout.clusters[1].x=0.0;
        layout.clusters[2].line=1;layout.clusters[2].x=12.0;
        for (at,movement,next) in [(0,"lineNext",1),(3,"lineStart",1),(1,"lineEnd",4),(0,"linePrev",0),(4,"lineNext",4)] {
            let query=request(&json!({"start":at,"end":at,"move":movement}),text).unwrap();
            assert_eq!(project(&layout,text,Affine::IDENTITY,query).unwrap()["next"],next,"{movement}");
        }
    }
}

#[cfg(test)]
mod click_tests {
    use super::*;
    #[test]
    fn multi_click_uses_unicode_words_visual_lines_and_paragraphs_without_rendering() {
        use photocraft_text::layout::LineInfo;
        let text="中😀 abc\ndef";
        let layout=TextLayout{lines:vec![LineInfo{range:0..12,baseline:10.,x0:0.,x1:30.,ascent:8.,descent:2.,paragraph:0},LineInfo{range:12..15,baseline:24.,x0:0.,x1:20.,ascent:8.,descent:2.,paragraph:1}],..Default::default()};
        assert_eq!(click_range(&layout,text,10,5.,"word"),(8,11));
        assert_eq!(click_range(&layout,text,0,22.,"line"),(12,15));
        assert_eq!(click_range(&layout,text,9,5.,"paragraph"),(0,11));
        assert_eq!(click_range(&layout,text,0,5.,"all"),(0,15));
        assert!(request(&json!({"start":0,"end":0,"unit":"word"}),text).is_err());
        assert!(request(&json!({"start":0,"end":0,"hit":[1,2],"unit":"unknown"}),text).is_err());
    }
}
#[cfg(test)] mod vertical_tests{
 use super::*;use photocraft_text::{LineInfo,ClusterInfo};
 #[test] fn vertical_caret_hit_selection_and_cluster_steps_use_native_line_space(){
  let text="中😀a";let layout=TextLayout{vertical:true,lines:vec![LineInfo{range:0..8,baseline:12.,x0:0.,x1:30.,ascent:10.,descent:3.,paragraph:0}],clusters:vec![ClusterInfo{range:0..3,x:0.,advance:10.,line:0,rtl:false},ClusterInfo{range:3..7,x:10.,advance:12.,line:0,rtl:false},ClusterInfo{range:7..8,x:22.,advance:8.,line:0,rtl:false}],..Default::default()};
  let q=request(&json!({"start":1,"end":3,"hit":[-5,11]}),text).unwrap();let value=project(&layout,text,Affine::IDENTITY,q).unwrap();assert_eq!(value["hit"],1);assert_eq!(value["caret"],json!([[-2.,22.],[-15.,22.]]));assert_eq!(value["selection"],json!([[[ -2.,10.],[-2.,22.],[-15.,22.],[-15.,10.]]]));
  for (at,move_,next) in [(1,"charNext",3),(3,"charPrev",1),(0,"charPrev",0),(4,"charNext",4)]{assert_eq!(project(&layout,text,Affine::IDENTITY,request(&json!({"start":at,"end":at,"move":move_}),text).unwrap()).unwrap()["next"],next);}
 }
 #[test] fn vertical_columns_hit_multiclick_and_navigation_keep_inline_position(){
  let text="abcd";let layout=TextLayout{vertical:true,lines:vec![LineInfo{range:0..2,baseline:12.,x0:0.,x1:20.,ascent:10.,descent:3.,paragraph:0},LineInfo{range:2..4,baseline:32.,x0:0.,x1:20.,ascent:10.,descent:3.,paragraph:0}],clusters:(0..4).map(|i|ClusterInfo{range:i..i+1,x:(i%2) as f32*10.,advance:10.,line:i/2,rtl:false}).collect(),..Default::default()};
  let transform=Affine{m:[0.,2.,-3.,0.,100.,50.]};
  for (at,move_,next) in [(1,"lineNext",3),(3,"linePrev",1),(3,"lineStart",2),(3,"lineEnd",4)]{assert_eq!(project(&layout,text,transform,request(&json!({"start":at,"end":at,"move":move_}),text).unwrap()).unwrap()["next"],next);}
  let p=transform.apply(Point::new(-30.,11.));let q=request(&json!({"start":0,"end":0,"hit":[p.x,p.y],"unit":"line"}),text).unwrap();let result=project(&layout,text,transform,q).unwrap();assert_eq!(result["hit"],3);assert_eq!(result["range"],json!([2,4]));
 }

}
