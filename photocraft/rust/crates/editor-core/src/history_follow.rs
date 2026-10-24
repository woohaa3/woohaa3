//! Opaque view key for the newest past state; no address or retained pixel ownership crosses WASM.
use std::{cell::RefCell,sync::{Arc,Weak}};
use photocraft_doc::Document;
#[derive(Default)]
pub(crate) struct HistoryFollowKey(RefCell<Option<(u64,Option<Weak<Document>>,u64)>>);
impl HistoryFollowKey {
    pub fn read(&self,state:&photocraft_engine::DocState)->String {
        let newest=state.history.past_len().checked_sub(1).and_then(|i|state.history.state(i)).map(|doc|Arc::downgrade(&doc));
        let mut previous=self.0.borrow_mut();
        let same=previous.as_ref().is_some_and(|(id,old,_)|*id==state.doc.id.0 && match (old,&newest){(None,None)=>true,(Some(a),Some(b))=>Weak::ptr_eq(a,b),_=>false});
        if !same {let next=previous.as_ref().map_or(1,|(_,_,key)|key.saturating_add(1));*previous=Some((state.doc.id.0,newest,next));}
        previous.as_ref().unwrap().2.to_string()
    }
}
