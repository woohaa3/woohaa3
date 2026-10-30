//! 图片源像素细节批次；只承载瞬时纹理，不进入规范文档。
use serde::Deserialize;
use std::sync::Arc;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FocusDetails {
    pub node_id: String,
    pub width: u32,
    pub height: u32,
    pub tiles: Vec<DetailTile>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DetailTile {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub cache_id: Option<u32>,
    #[serde(default)]
    pub reuse: bool,
}
impl DetailTile {
    pub fn rect(&self) -> [u32; 4] {
        [self.x, self.y, self.x + self.width, self.y + self.height]
    }
}

impl FocusDetails {
    pub fn bounds(&self) -> [u32; 4] {
        let x = self.tiles.iter().map(|t| t.x).min().unwrap_or(0);
        let y = self.tiles.iter().map(|t| t.y).min().unwrap_or(0);
        let right = self.tiles.iter().map(|t| t.x + t.width).max().unwrap_or(0);
        let bottom = self.tiles.iter().map(|t| t.y + t.height).max().unwrap_or(0);
        [x, y, right, bottom]
    }
    pub fn validate(&self, bytes: usize) -> Result<(), &'static str> {
        if self.node_id.is_empty()
            || self.node_id.len() > 128
            || self.width == 0
            || self.height == 0
            || self.width > 32768
            || self.height > 32768
            || self.tiles.is_empty()
            || self.tiles.len() > 64
        {
            return Err("Invalid focus detail frame");
        }
        let mut area = 0u64;
        let mut payload = 0u64;
        for (i, t) in self.tiles.iter().enumerate() {
            if t.width == 0
                || t.height == 0
                || t.width > 512
                || t.height > 512
                || t.x.checked_add(t.width).is_none_or(|x| x > self.width)
                || t.y.checked_add(t.height).is_none_or(|y| y > self.height)
            {
                return Err("Invalid focus detail tile");
            }
            for p in &self.tiles[..i] {
                if t.x < p.x + p.width
                    && p.x < t.x + t.width
                    && t.y < p.y + p.height
                    && p.y < t.y + t.height
                {
                    return Err("Overlapping focus detail tiles");
                }
            }
            if t.reuse && t.cache_id.is_none() {
                return Err("Missing focus detail cache id");
            }
            area += u64::from(t.width) * u64::from(t.height);
            if !t.reuse {
                payload += u64::from(t.width) * u64::from(t.height) * 4;
            }
        }
        let [x, y, right, bottom] = self.bounds();
        if area != u64::from(right - x) * u64::from(bottom - y) || payload != bytes as u64 {
            return Err("Incomplete focus detail frame");
        }
        Ok(())
    }
    /// 基础图只显示细节矩形之外的四块，避免重复混合 alpha。
    pub fn base_regions(&self) -> Vec<[u32; 4]> {
        let [x, y, r, b] = self.bounds();
        [
            [0, 0, self.width, y],
            [0, b, self.width, self.height],
            [0, y, x, b],
            [r, y, self.width, b],
        ]
        .into_iter()
        .filter(|a| a[0] < a[2] && a[1] < a[3])
        .collect()
    }
}

#[derive(Clone)]
pub(crate) struct FocusDetailUpload {
    pub frame: FocusDetails,
    pub pixels: Vec<Arc<[u8]>>,
}

/// 在入口解析引用，排队内容始终自足；latest-wins 不丢失被跳过批次的像素。
impl FocusDetailUpload {
    pub fn resolve(
        frame: FocusDetails,
        bytes: &[u8],
        previous: Option<&Self>,
    ) -> Result<Self, &'static str> {
        frame.validate(bytes.len())?;
        let previous = previous.filter(|p| {
            p.frame.node_id == frame.node_id
                && p.frame.width == frame.width
                && p.frame.height == frame.height
        });
        let mut offset = 0;
        let mut pixels = Vec::with_capacity(frame.tiles.len());
        for tile in &frame.tiles {
            let data = if tile.reuse {
                let prior = previous.ok_or("Missing focus detail cache")?;
                let index = prior
                    .frame
                    .tiles
                    .iter()
                    .position(|t| t.cache_id == tile.cache_id && t.rect() == tile.rect())
                    .ok_or("Unknown focus detail cache entry")?;
                prior.pixels[index].clone()
            } else {
                let length = tile.width as usize * tile.height as usize * 4;
                let data = Arc::from(&bytes[offset..offset + length]);
                offset += length;
                data
            };
            pixels.push(data);
        }
        Ok(Self { frame, pixels })
    }
}

/// 输入队列只保留最后一份完整快照；解析失败不得推进缓存或覆盖已排队数据。
#[derive(Default)]
pub(crate) struct FocusDetailInbox {
    cache: Option<FocusDetailUpload>,
    pending: Option<Option<FocusDetailUpload>>,
}
impl FocusDetailInbox {
    pub const fn new() -> Self {
        Self {
            cache: None,
            pending: None,
        }
    }
    pub fn queue(&mut self, frame: Option<FocusDetails>, bytes: &[u8]) -> Result<(), &'static str> {
        if frame.is_none() && !bytes.is_empty() {
            return Err("Unexpected focus detail pixels");
        }
        let upload = frame
            .map(|frame| FocusDetailUpload::resolve(frame, bytes, self.cache.as_ref()))
            .transpose()?;
        self.cache = upload.clone();
        self.pending = Some(upload);
        Ok(())
    }
    pub fn take(&mut self) -> Option<Option<FocusDetailUpload>> {
        self.pending.take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn frame() -> FocusDetails {
        FocusDetails {
            node_id: "image".into(),
            width: 4096,
            height: 3000,
            tiles: vec![
                DetailTile {
                    x: 1024,
                    y: 512,
                    width: 512,
                    height: 512,
                    cache_id: None,
                    reuse: false,
                },
                DetailTile {
                    x: 1536,
                    y: 512,
                    width: 512,
                    height: 512,
                    cache_id: None,
                    reuse: false,
                },
            ],
        }
    }
    #[test]
    fn detail_and_base_regions_partition_the_document_without_overlap() {
        let f = frame();
        assert!(f.validate(512 * 512 * 2 * 4).is_ok());
        let mut rects = f.base_regions();
        rects.push(f.bounds());
        let area: u64 = rects
            .iter()
            .map(|r| u64::from(r[2] - r[0]) * u64::from(r[3] - r[1]))
            .sum();
        assert_eq!(area, u64::from(f.width) * u64::from(f.height));
        for (i, a) in rects.iter().enumerate() {
            for b in &rects[..i] {
                assert!(!(a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]));
            }
        }
    }
    #[test]
    fn malformed_capacity_gaps_overlap_and_pixel_lengths_are_rejected() {
        assert!(frame().validate(4).is_err());
        let mut f = frame();
        f.tiles[1].x = 1024;
        assert!(f.validate(512 * 512 * 2 * 4).is_err());
        f.tiles[1].x = 2048;
        assert!(f.validate(512 * 512 * 2 * 4).is_err());
        f.tiles[1].x = u32::MAX;
        assert!(f.validate(512 * 512 * 2 * 4).is_err());
        let mut f = frame();
        f.tiles[0].width = 513;
        assert!(f.validate(0).is_err());
        let mut f = frame();
        f.tiles.clear();
        assert!(f.validate(0).is_err());
        assert!(
            serde_json::from_str::<FocusDetails>(
                r#"{"nodeId":"a","width":1,"height":1,"tiles":[],"target":"mask"}"#
            )
            .is_err()
        );
    }
    #[test]
    fn incremental_references_are_resolved_before_latest_wins_and_checked_atomically() {
        let make = |reuse: bool| {
            serde_json::from_value::<FocusDetails>(serde_json::json!({
                "nodeId":"image","width":4096,"height":3000,
                "tiles":[{"x":0,"y":0,"width":1,"height":1,"cacheId":1,"reuse":reuse},
                         {"x":1,"y":0,"width":1,"height":1,"cacheId":2,"reuse":reuse}]
            }))
            .unwrap()
        };
        let initial =
            FocusDetailUpload::resolve(make(false), &[1, 2, 3, 4, 5, 6, 7, 8], None).unwrap();
        let middle = FocusDetailUpload::resolve(make(true), &[], Some(&initial)).unwrap();
        let last = FocusDetailUpload::resolve(make(true), &[], Some(&middle)).unwrap();
        assert!(Arc::ptr_eq(&initial.pixels[0], &last.pixels[0]));
        drop(middle);
        drop(initial);
        assert_eq!(last.pixels[1].as_ref(), &[5, 6, 7, 8]);
        assert!(FocusDetailUpload::resolve(make(true), &[], None).is_err());
        let mut invalid = make(true);
        invalid.tiles[1].cache_id = Some(99);
        assert!(FocusDetailUpload::resolve(invalid, &[], Some(&last)).is_err());
        let mut invalid = make(true);
        invalid.tiles[1].cache_id = None;
        assert!(invalid.validate(0).is_err());
        let mut invalid = make(true);
        invalid.node_id = "other".into();
        assert!(FocusDetailUpload::resolve(invalid, &[], Some(&last)).is_err());
        assert!(FocusDetailUpload::resolve(make(true), &[0], Some(&last)).is_err());
        let mut mixed = make(true);
        mixed.tiles[1].reuse = false;
        mixed.tiles[1].cache_id = Some(3);
        let next = FocusDetailUpload::resolve(mixed, &[9, 10, 11, 12], Some(&last)).unwrap();
        assert!(Arc::ptr_eq(&last.pixels[0], &next.pixels[0]));
        assert!(!Arc::ptr_eq(&last.pixels[1], &next.pixels[1]));
        assert_eq!(next.pixels[1].as_ref(), &[9, 10, 11, 12]);
    }

    #[test]
    fn focus_details_resolve_before_queue_and_reject_without_replacing_pending() {
        let mut inbox = FocusDetailInbox::new();
        let make = |reuse: bool, id: u32| {
            serde_json::from_value::<FocusDetails>(serde_json::json!({
                "nodeId":"image","width":4096,"height":3000,
                "tiles":[{"x":0,"y":0,"width":1,"height":1,"cacheId":id,"reuse":reuse}]
            }))
            .unwrap()
        };
        inbox.queue(None, &[]).unwrap();
        inbox.take();
        inbox.queue(Some(make(false, 1)), &[1, 2, 3, 4]).unwrap();
        inbox.queue(Some(make(true, 1)), &[]).unwrap();
        assert!(inbox.queue(Some(make(true, 99)), &[]).is_err());
        assert!(inbox.queue(None, &[0]).is_err());
        let upload = inbox.take().unwrap().unwrap();
        assert_eq!(upload.pixels[0].as_ref(), &[1, 2, 3, 4]);
        // 上次批次已消费，入口缓存仍可解析下一次引用。
        inbox.queue(Some(make(true, 1)), &[]).unwrap();
        assert!(inbox.take().unwrap().is_some());
        inbox.queue(None, &[]).unwrap();
        assert!(inbox.queue(Some(make(true, 1)), &[]).is_err());
        assert!(inbox.take().unwrap().is_none());
    }
}
