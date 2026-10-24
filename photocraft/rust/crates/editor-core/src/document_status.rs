//! Logical document sizes and profile labels; never claim hardware memory or performance.
use photocraft_doc::{Document,LayerContent};
use serde_json::{Value,json};
pub fn inspect(doc:&Document)->Value {
 let bpc=(doc.depth.bits()/8).max(1) as u64;let channels=doc.mode.color_channels().max(1) as u64;
 let flat=doc.size.width as u64*doc.size.height as u64*channels*bpc;
 let layered:u64=doc.walk().iter().filter_map(|(_,_,layer)|match &layer.content {LayerContent::Raster(surface)=>{let r=surface.tile_bounds().intersect(&doc.bounds());Some(r.width().max(0) as u64*r.height().max(0) as u64*(channels+1)*bpc)},_=>None}).sum();
 let profile=match &doc.icc_profile {
  None=>format!("未标记 {:?}",doc.mode),
  Some(bytes)=>match photocraft_engine::color_cmds::profile_from_bytes(bytes) {
   Ok(profile) if profile.color_space==photocraft_engine::color_cmds::mode_space(doc.mode)=>{let name:String=profile.description.chars().filter(|c|!c.is_control()).take(128).collect();if name.trim().is_empty(){format!("未命名 {:?} 配置文件",doc.mode)}else{name.trim().into()}},
   _=>format!("无效 {:?} 配置文件",doc.mode),
  }
 };
 json!({"flatBytes":flat,"layeredBytes":layered.max(flat),"profile":profile})
}
#[cfg(test)]mod tests {
 use super::*;use photocraft_engine::Session;
 #[test]fn document_status_is_read_only_and_describes_profile_errors() {
  let mut s=Session::new();s.execute("file.new",json!({"width":10,"height":8})).unwrap();let original=s.active().unwrap().doc.clone();
  let value=inspect(&original);assert_eq!(value["flatBytes"],240);assert!(value["layeredBytes"].as_u64().unwrap()>=240);assert_eq!(s.active().unwrap().doc,original);
  let mut doc=(*original).clone();doc.icc_profile=Some(std::sync::Arc::new(vec![1,2,3]));assert!(inspect(&doc)["profile"].as_str().unwrap().contains("无效"));
  doc.icc_profile=Some(photocraft_engine::color_cmds::working_profile(doc.mode).to_bytes());assert!(!inspect(&doc)["profile"].as_str().unwrap().contains("无效"));
 }
}
