//! PAT 字节边界：整批检查元数据后才调用上游解码，不读写文档或图案库。
use std::{collections::HashSet, ops::Range};

use photocraft_doc::Pattern;
use photocraft_project_verify::limits::{MAX_PATTERN_PIXELS, MAX_PATTERN_SIDE, MAX_PATTERNS};
use serde::Serialize;

use crate::error::{EditorError, Result};

/// 足以容纳资源上限内的 RGB/U8、透明通道及 RLE 行表。
pub const MAX_FILE_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PatternPresetInfo {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
}

fn error(message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed {
        id: "pattern.preset".into(),
        message: message.to_string(),
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    position: usize,
}
impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }
    fn take(&mut self, count: usize) -> Result<&'a [u8]> {
        let end = self
            .position
            .checked_add(count)
            .ok_or_else(|| error("PAT 数据段长度溢出"))?;
        let value = self
            .bytes
            .get(self.position..end)
            .ok_or_else(|| error("PAT 数据不完整"))?;
        self.position = end;
        Ok(value)
    }
    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16> {
        Ok(u16::from_be_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn rect(&mut self) -> Result<[i32; 4]> {
        Ok([
            self.u32()? as i32,
            self.u32()? as i32,
            self.u32()? as i32,
            self.u32()? as i32,
        ])
    }
    fn finished(&self) -> bool {
        self.position == self.bytes.len()
    }
}

struct CheckedFile {
    presets: Vec<PatternPresetInfo>,
    records: Vec<Range<usize>>,
}

fn check(bytes: &[u8]) -> Result<CheckedFile> {
    if bytes.len() > MAX_FILE_BYTES {
        return Err(error("PAT 文件不能超过 32 MiB"));
    }
    let mut reader = Reader::new(bytes);
    if reader.take(4)? != b"8BPT" || reader.u16()? != 1 {
        return Err(error("不支持的 PAT 文件或版本"));
    }
    let count = reader.u32()? as usize;
    if count == 0 || count > MAX_PATTERNS {
        return Err(error("每个 PAT 文件须含 1–64 个图案"));
    }
    let mut result = CheckedFile {
        presets: Vec::with_capacity(count),
        records: Vec::with_capacity(count),
    };
    let mut ids = HashSet::new();
    let mut pixels = 0u64;
    for _ in 0..count {
        let start = reader.position;
        if reader.u32()? != 1 || reader.u32()? != 3 {
            return Err(error("PAT 仅支持版本 1 的 RGB 图案"));
        }
        let height = u32::from(reader.u16()?);
        let width = u32::from(reader.u16()?);
        pixels += u64::from(width) * u64::from(height);
        if width == 0
            || height == 0
            || width > MAX_PATTERN_SIDE
            || height > MAX_PATTERN_SIDE
            || pixels > MAX_PATTERN_PIXELS
        {
            return Err(error("图案尺寸或累计像素超限"));
        }
        let name_length = reader.u32()? as usize;
        if name_length == 0 || name_length > 201 {
            return Err(error("图案名称须为 1–200 个 UTF-16 单位"));
        }
        let units: Vec<_> = reader
            .take(name_length * 2)?
            .chunks_exact(2)
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
            .collect();
        let name = String::from_utf16(&units).map_err(|_| error("图案名称包含无效 UTF-16"))?;
        let name = name.strip_suffix('\0').unwrap_or(&name).to_string();
        if name.trim().is_empty() || name.contains('\0') || name.encode_utf16().count() > 200 {
            return Err(error("图案名称无效或超限"));
        }
        let id_length = usize::from(reader.u8()?);
        let id = std::str::from_utf8(reader.take(id_length)?)
            .map_err(|_| error("图案身份包含无效 UTF-8"))?
            .to_string();
        if id.trim().is_empty()
            || id.contains('\0')
            || id.encode_utf16().count() > 200
            || !ids.insert(id.clone())
        {
            return Err(error("图案身份为空、超限或重复"));
        }
        if reader.u32()? != 3 {
            return Err(error("不支持的 PAT 通道表版本"));
        }
        let body_length = reader.u32()? as usize;
        check_channels(reader.take(body_length)?, width, height)?;
        result.presets.push(PatternPresetInfo {
            id,
            name,
            width,
            height,
        });
        result.records.push(start..reader.position);
    }
    if !reader.finished() {
        return Err(error("PAT 文件含未声明的尾部数据"));
    }
    Ok(result)
}

fn check_channels(bytes: &[u8], width: u32, height: u32) -> Result<()> {
    let mut reader = Reader::new(bytes);
    let [top, left, bottom, right] = reader.rect()?;
    if right.checked_sub(left) != Some(width as i32)
        || bottom.checked_sub(top) != Some(height as i32)
    {
        return Err(error("图案通道表尺寸与图案尺寸不一致"));
    }
    let slots = reader.u32()?;
    if slots > 64 {
        return Err(error("PAT 通道槽位超限"));
    }
    let mut written = 0;
    for _ in 0..slots + 2 {
        match reader.u32()? {
            0 => continue,
            1 => (),
            _ => return Err(error("PAT 通道标记无效")),
        }
        let length = reader.u32()? as usize;
        if length == 0 {
            continue;
        }
        written += 1;
        if written > 4 {
            return Err(error("PAT 仅支持 RGB 和可选透明通道"));
        }
        let mut channel = Reader::new(reader.take(length)?);
        if channel.u32()? != 8 {
            return Err(error("PAT 仅支持 8 位通道"));
        }
        let [ct, cl, cb, cr] = channel.rect()?;
        if ct < top || cl < left || cb > bottom || cr > right || cb <= ct || cr <= cl {
            return Err(error("PAT 通道范围无效"));
        }
        if channel.u16()? != 8 {
            return Err(error("PAT 通道位深不一致"));
        }
        let compression = channel.u8()?;
        let data = channel.take(
            length
                .checked_sub(23)
                .ok_or_else(|| error("PAT 通道头不完整"))?,
        )?;
        let rows = (cb - ct) as usize;
        let columns = (cr - cl) as usize;
        match compression {
            0 if data.len() == rows * columns => (),
            1 => {
                let mut rle = Reader::new(data);
                let mut row_lengths = Vec::with_capacity(rows);
                for _ in 0..rows {
                    row_lengths.push(usize::from(rle.u16()?));
                }
                for length in row_lengths {
                    if length == 0 || length.saturating_mul(64) < columns {
                        return Err(error("PAT 压缩行长度不足"));
                    }
                    rle.take(length)?;
                }
                if !rle.finished() {
                    return Err(error("PAT 压缩通道含多余数据"));
                }
            }
            _ => return Err(error("PAT 通道长度或压缩格式不支持")),
        }
    }
    if written < 3 || !reader.finished() {
        return Err(error("PAT RGB 通道不完整或含多余数据"));
    }
    Ok(())
}

/// 只检查结构和预算，不解码或采样像素，可用于导入前显示整批元数据。
pub fn inspect(bytes: &[u8]) -> Result<Vec<PatternPresetInfo>> {
    Ok(check(bytes)?.presets)
}

/// 整批预检通过后，复用上游有界解析器及 RGB Surface 转换。
/// 返回临时资源，由调用方在合并容量与身份检查通过后一次发布。
pub fn import(bytes: &[u8]) -> Result<Vec<Pattern>> {
    let checked = check(bytes)?;
    // 上游 PAT 入口没有预算参数；包装成同格式的 tagged block，使用共享小预算。
    let mut block = Vec::with_capacity(bytes.len() + checked.records.len() * 7);
    for range in checked.records {
        let record = &bytes[range];
        block.extend_from_slice(&(record.len() as u32).to_be_bytes());
        block.extend_from_slice(record);
        block.extend(std::iter::repeat_n(0, (4 - record.len() % 4) % 4));
    }
    let mut budget =
        photocraft_psd::patterns::PatternBudget::with_decoded_limit(MAX_PATTERN_PIXELS * 4);
    let decoded = photocraft_psd::patterns::parse_pattern_block_with(&block, &mut budget)
        .map_err(|e| error(format!("无法读取 PAT：{e}")))?;
    let patterns = decoded
        .iter()
        .map(|pattern| {
            photocraft_io::pattern_map::from_psd(pattern).ok_or_else(|| error("PAT 图案转换失败"))
        })
        .collect::<Result<Vec<_>>>()?;
    if patterns.len() != checked.presets.len()
        || !photocraft_project_verify::pattern_support::supported(&patterns)
    {
        return Err(error("解码后的图案资源不符合工程限制"));
    }
    Ok(patterns)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 手写格式样本只供结构检查；不调用像素编解码或 Surface 转换。
    fn record(id: &str, width: u16, height: u16, compression: u8) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&1u32.to_be_bytes());
        out.extend_from_slice(&3u32.to_be_bytes());
        out.extend_from_slice(&height.to_be_bytes());
        out.extend_from_slice(&width.to_be_bytes());
        let name: Vec<_> = "图案\0".encode_utf16().collect();
        out.extend_from_slice(&(name.len() as u32).to_be_bytes());
        for unit in name {
            out.extend_from_slice(&unit.to_be_bytes());
        }
        out.push(id.len() as u8);
        out.extend_from_slice(id.as_bytes());
        let rect = [0i32, 0, i32::from(height), i32::from(width)];
        let mut body = Vec::new();
        for value in rect {
            body.extend_from_slice(&value.to_be_bytes());
        }
        body.extend_from_slice(&3u32.to_be_bytes());
        for _ in 0..3 {
            let data = if compression == 1 {
                let mut data = Vec::new();
                let row_length = width.div_ceil(64).max(2);
                for _ in 0..height {
                    data.extend_from_slice(&row_length.to_be_bytes());
                }
                // 仅满足行表及展开预算的占位数据，不执行 PackBits 解码。
                data.resize(
                    data.len() + usize::from(height) * usize::from(row_length),
                    0,
                );
                data
            } else {
                vec![0; usize::from(width) * usize::from(height)]
            };
            body.extend_from_slice(&1u32.to_be_bytes());
            body.extend_from_slice(&((23 + data.len()) as u32).to_be_bytes());
            body.extend_from_slice(&8u32.to_be_bytes());
            for value in rect {
                body.extend_from_slice(&value.to_be_bytes());
            }
            body.extend_from_slice(&8u16.to_be_bytes());
            body.push(compression);
            body.extend_from_slice(&data);
        }
        body.extend_from_slice(&0u32.to_be_bytes());
        body.extend_from_slice(&0u32.to_be_bytes());
        out.extend_from_slice(&3u32.to_be_bytes());
        out.extend_from_slice(&(body.len() as u32).to_be_bytes());
        out.extend_from_slice(&body);
        out
    }
    fn file(records: &[Vec<u8>]) -> Vec<u8> {
        let mut bytes = b"8BPT\0\x01".to_vec();
        bytes.extend_from_slice(&(records.len() as u32).to_be_bytes());
        for record in records {
            bytes.extend_from_slice(record);
        }
        bytes
    }
    #[test]
    fn checks_rgb_raw_rle_and_complete_record_ranges_without_decoding() {
        let records = [record("one", 4, 3, 0), record("two", 128, 7, 1)];
        let bytes = file(&records);
        let checked = check(&bytes).unwrap();
        assert_eq!(
            checked.presets[0],
            PatternPresetInfo {
                id: "one".into(),
                name: "图案".into(),
                width: 4,
                height: 3
            }
        );
        assert_eq!(checked.presets.len(), 2);
        for (range, expected) in checked.records.iter().zip(&records) {
            assert_eq!(&bytes[range.clone()], expected);
        }
        assert_eq!(inspect(&bytes).unwrap(), checked.presets);
    }
    #[test]
    fn rejects_every_truncation_trailing_bytes_version_and_identity() {
        let bytes = file(&[record("one", 4, 3, 0)]);
        for end in 0..bytes.len() {
            assert!(inspect(&bytes[..end]).is_err(), "accepted prefix {end}");
        }
        let mut bad = bytes.clone();
        bad.push(0);
        assert!(inspect(&bad).is_err());
        let mut bad = bytes.clone();
        bad[5] = 2;
        assert!(inspect(&bad).is_err());
        assert!(inspect(&file(&[])).is_err());
        assert!(inspect(&file(&[record("one", 1, 1, 0), record("one", 1, 1, 0)])).is_err());
        assert!(inspect(&file(&[record(" ", 1, 1, 0)])).is_err());
        assert!(inspect(&file(&[record(&"x".repeat(201), 1, 1, 0)])).is_err());
        let mut bad = bytes;
        bad[10 + 23] = 0xff;
        assert!(inspect(&bad).is_err());
    }
    #[test]
    fn rejects_batch_budgets_before_the_decoder() {
        assert!(inspect(&vec![0; MAX_FILE_BYTES + 1]).is_err());
        assert!(
            inspect(&file(
                &(0..65)
                    .map(|i| record(&i.to_string(), 1, 1, 0))
                    .collect::<Vec<_>>()
            ))
            .is_err()
        );
        assert!(inspect(&file(&[record("one", 1025, 1, 0)])).is_err());
        // 尺寸预算在读取通道前检查；后续记录无需分配像素大小的载荷。
        let mut bytes = file(&[]);
        bytes[6..10].copy_from_slice(&5u32.to_be_bytes());
        for i in 0..4 {
            bytes.extend_from_slice(&record(&i.to_string(), 1024, 1024, 1));
        }
        let mut allowed = bytes.clone();
        allowed[6..10].copy_from_slice(&4u32.to_be_bytes());
        assert_eq!(inspect(&allowed).unwrap().len(), 4);
        let mut over = record("over", 1, 1, 0);
        over[8..10].copy_from_slice(&1024u16.to_be_bytes());
        over[10..12].copy_from_slice(&1024u16.to_be_bytes());
        bytes.extend_from_slice(&over);
        assert!(
            import(&bytes)
                .unwrap_err()
                .message()
                .contains("累计像素超限")
        );
    }
    #[test]
    fn rejects_unsupported_channels_and_malformed_lengths_without_decoding() {
        let base = record("one", 4, 3, 0);
        let body_start = 12 + 4 + 6 + 1 + 3 + 8;
        for (offset, value) in [
            (7, 4),
            (body_start + 15, 5),
            (body_start + 20 + 3, 2),
            (body_start + 28 + 3, 16),
            (body_start + 28 + 22, 2),
        ] {
            let mut bad = base.clone();
            bad[offset] = value;
            assert!(
                inspect(&file(&[bad])).is_err(),
                "accepted mutation {offset}"
            );
        }
        let mut bad = base;
        bad[body_start + 24..body_start + 28].copy_from_slice(&u32::MAX.to_be_bytes());
        assert!(inspect(&file(&[bad])).is_err());
        let mut bad = record("rle", 4, 3, 1);
        bad[body_start + 28 + 23] = 0xff;
        assert!(inspect(&file(&[bad])).is_err());
    }
    #[test]
    fn validates_utf16_names_and_accepts_exact_count_limit() {
        let named = |units: &[u16]| {
            let mut bytes = record("one", 1, 1, 0);
            bytes[12..16].copy_from_slice(&(units.len() as u32).to_be_bytes());
            bytes.splice(16..22, units.iter().flat_map(|unit| unit.to_be_bytes()));
            file(&[bytes])
        };
        let name = "字".repeat(200);
        let terminated: Vec<_> = name.encode_utf16().chain([0]).collect();
        assert_eq!(inspect(&named(&terminated)).unwrap()[0].name, name);
        assert!(inspect(&named(&[0xd800, 0])).is_err());
        assert!(inspect(&named(&[65, 0, 66, 0])).is_err());
        assert!(inspect(&named(&[0])).is_err());
        assert!(inspect(&named(&vec![65; 201])).is_err());
        let astral: Vec<_> = "😀".repeat(101).encode_utf16().collect();
        assert!(inspect(&named(&astral)).is_err());
        assert_eq!(
            inspect(&file(
                &(0..64)
                    .map(|i| record(&i.to_string(), 1, 1, 0))
                    .collect::<Vec<_>>()
            ))
            .unwrap()
            .len(),
            64
        );
    }
    #[test]
    fn accepts_optional_alpha_but_rejects_extra_planes_and_invalid_channel_rects() {
        let base = record("one", 4, 3, 0);
        let body_start = 34;
        let plane_start = body_start + 20;
        let plane_length = 8 + 23 + 12;
        let add_plane = |bytes: &mut Vec<u8>| {
            let plane = bytes[plane_start..plane_start + plane_length].to_vec();
            let insert = bytes.len() - 8;
            bytes.splice(insert..insert, plane);
            let body_length = (bytes.len() - body_start) as u32;
            bytes[body_start - 4..body_start].copy_from_slice(&body_length.to_be_bytes());
        };
        let mut alpha = base.clone();
        // Replace one empty optional slot with an alpha plane.
        add_plane(&mut alpha);
        alpha.truncate(alpha.len() - 4);
        let body_length = (alpha.len() - body_start) as u32;
        alpha[body_start - 4..body_start].copy_from_slice(&body_length.to_be_bytes());
        assert!(inspect(&file(&[alpha.clone()])).is_ok());
        let fifth = alpha[plane_start..plane_start + plane_length].to_vec();
        let insert = alpha.len() - 4;
        alpha.splice(insert..insert, fifth);
        alpha[body_start + 16..body_start + 20].copy_from_slice(&4u32.to_be_bytes());
        let body_length = (alpha.len() - body_start) as u32;
        alpha[body_start - 4..body_start].copy_from_slice(&body_length.to_be_bytes());
        assert!(inspect(&file(&[alpha])).is_err());
        let mut bad = base.clone();
        bad[body_start + 4..body_start + 8].copy_from_slice(&i32::MIN.to_be_bytes());
        bad[body_start + 12..body_start + 16].copy_from_slice(&i32::MAX.to_be_bytes());
        assert!(inspect(&file(&[bad])).is_err());
        let mut bad = base;
        let channel_rect = plane_start + 8 + 4;
        bad[channel_rect..channel_rect + 4].copy_from_slice(&(-1i32).to_be_bytes());
        assert!(inspect(&file(&[bad])).is_err());
    }
}
