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
}

/// 在布局前校验，拒绝利用查询参数修改图层或开放其他文字能力。
pub(crate) fn request(value: &Value, text: &str) -> Result<Request> {
    let params=value.as_object().ok_or_else(||error("文字几何参数必须是对象"))?;
    if params.keys().any(|key|!matches!(key.as_str(),"start"|"end"|"hit"|"move")) {
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
        Some(value.as_str().filter(|v|matches!(*v,"linePrev"|"lineNext"|"lineStart"|"lineEnd"|"wordPrev"|"wordNext"))
            .ok_or_else(||error("文字导航动作无效"))?.to_string())
    } else {None};
    Ok(Request{start,end,hit,movement})
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
    if let Some(movement)=request.movement.as_deref() {
        let index=text[..request.end].chars().count();
        let next=match movement {
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
