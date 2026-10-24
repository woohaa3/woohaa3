use super::*;
fn summarize(bins:&[u32;256])->Value {
    let count=bins.iter().map(|v|u64::from(*v)).sum::<u64>();
    if count==0{return json!({"bins":bins.to_vec(),"mean":null,"stdDev":null,"median":null,"samples":0});}
    let mean=bins.iter().enumerate().map(|(i,n)|i as f64*f64::from(*n)).sum::<f64>()/count as f64;
    let variance=bins.iter().enumerate().map(|(i,n)|(i as f64-mean).powi(2)*f64::from(*n)).sum::<f64>()/count as f64;
    let mut sum=0u64;let median=bins.iter().position(|n|{sum+=u64::from(*n);sum*2>=count}).unwrap_or(0);
    json!({"bins":bins.to_vec(),"mean":mean,"stdDev":variance.sqrt(),"median":median,"samples":count})
}
impl Editor {
    /// Same 384px proxy and channel bins as upstream tone::histogram_panel; not full-size counts.
    pub fn histogram(&self)->Result<Value> {
        let doc=self.preview_document()?;let image=photocraft_compose::thumbnail(doc,384);
        let mut bins=[[0u32;256];4];
        for p in image.pixels.chunks_exact(4) {
            if p[3]==0{continue;}
            for c in 0..3{bins[c+1][p[c] as usize]+=1;}
            bins[0][(u32::from(p[0])+u32::from(p[1])+u32::from(p[2])) as usize/3]+=1;
        }
        let level=(doc.size.width.max(doc.size.height) as f32/384.).max(1.).log2().ceil() as u32+1;
        Ok(json!({"channels":bins.iter().map(summarize).collect::<Vec<_>>(),"pixels":u64::from(doc.size.width)*u64::from(doc.size.height),"cacheLevel":level}))
    }
}
#[cfg(test)]mod tests {
    use super::*;
    #[test]fn statistics_use_native_bins_and_skip_empty_samples(){let mut bins=[0;256];assert_eq!(summarize(&bins)["mean"],Value::Null);bins[0]=1;bins[100]=1;let s=summarize(&bins);assert_eq!(s["mean"],50.);assert_eq!(s["stdDev"],50.);assert_eq!(s["median"],0);assert_eq!(s["samples"],2);}
    #[test]fn histogram_reads_preview_without_document_mutation(){
        let mut editor=Editor::new();editor.execute("file.new",json!({"width":8,"height":6})).unwrap();editor.execute("layer.new.layer",json!({})).unwrap();
        let hash=editor.content_hash().unwrap();let before=editor.state();let h=editor.histogram().unwrap();assert_eq!(h["pixels"],48);assert_eq!(h["cacheLevel"],1);assert_eq!(editor.state(),before);
        editor.begin_stroke(json!({"strokeCommand":"paint.pencil","points":[[4,5]],"size":1,"color":"#ff0000","smoothing":0})).unwrap();let draft=editor.state();let h=editor.histogram().unwrap();assert_eq!(h["channels"][1]["bins"][255],48);assert_eq!(h["channels"][0]["bins"][85],1);assert_eq!(editor.state(),draft);assert_eq!(editor.content_hash().unwrap(),hash);editor.cancel_stroke();
    }
}
