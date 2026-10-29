//! 最小 MP4 封装器（H.264 video only，Fast Start）
//! （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 4.3 / design D5）。
//!
//! 为什么要自己写：`fast-start` 要求 `moov` 在 `mdat` 之前，而样本大小/偏移只有编码完才知道。
//! 这里用**两段式**：
//! 1. 编码阶段把每个样本写入磁盘 spool，同时记录大小与 PTS；
//! 2. 收尾时先算好 `moov`（含 `stco` 绝对偏移），写 `ftyp`+`moov`，再**流式拷贝** spool 到
//!    `mdat`。
//!
//! 这样内存占用与片段长度无关（只有元数据），也不依赖外部 muxer。
//! 只支持 H.264 video track、无音轨，与首期 profile 一致。

use std::fs::File;
use std::io::{BufWriter, Read, Write};
use std::path::Path;

use crate::recording_encode::{EncodeFailure, EncodeStage, sha256_hex};

/// 一个已编码样本（AVCC 格式，长度前缀）。
#[derive(Clone, Debug)]
pub struct EncodedSample {
    /// 相对 PTS（以 timescale 为单位）。
    pub pts: u64,
    /// 呈现时长（timescale 单位）。
    pub duration: u64,
    /// 是否关键帧（决定是否写入 `stss`）。
    pub keyframe: bool,
    /// 样本字节数。
    pub size: u32,
}

/// 编码器在收尾时提供的参数。
#[derive(Clone, Debug)]
pub struct MuxOptions {
    pub width: u32,
    pub height: u32,
    /// 时间刻度；常取帧率分母与秒的换算基准。
    pub timescale: u32,
    /// SPS（不含起始码，已去除 emulation 前的 NAL 负载）。
    pub sps: Vec<u8>,
    /// PPS。
    pub pps: Vec<u8>,
}

/// `moov` 之外的写入结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MuxResult {
    pub size_bytes: u64,
    pub duration_units: u64,
    pub frame_count: u64,
}

fn write_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_be_bytes());
}

fn write_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_be_bytes());
}

/// 写一个 box 头 + 负载；返回写入的总长度。
fn write_box(out: &mut Vec<u8>, kind: &[u8; 4], payload: &[u8]) -> u32 {
    let size = 8 + payload.len() as u32;
    write_u32(out, size);
    out.extend_from_slice(kind);
    out.extend_from_slice(payload);
    size
}

fn write_full_box(
    out: &mut Vec<u8>,
    kind: &[u8; 4],
    version: u8,
    flags: u32,
    payload: &[u8],
) -> u32 {
    let mut body = Vec::with_capacity(4 + payload.len());
    body.push(version);
    body.extend_from_slice(&flags.to_be_bytes()[1..]);
    body.extend_from_slice(payload);
    write_box(out, kind, &body)
}

/// 构造 `ftyp`：isom + iso2 + avc1 兼容品牌。
fn ftyp() -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(b"isom");
    write_u32(&mut payload, 0x200);
    payload.extend_from_slice(b"isom");
    payload.extend_from_slice(b"iso2");
    payload.extend_from_slice(b"avc1");
    payload.extend_from_slice(b"mp41");
    let mut out = Vec::new();
    write_box(&mut out, b"ftyp", &payload);
    out
}

fn matrix() -> [u8; 36] {
    let mut out = [0u8; 36];
    let values: [u32; 9] = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000];
    for (index, value) in values.iter().enumerate() {
        out[index * 4..index * 4 + 4].copy_from_slice(&value.to_be_bytes());
    }
    out
}

fn mvhd(timescale: u32, duration: u64) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&0u32.to_be_bytes()); // creation_time
    payload.extend_from_slice(&0u32.to_be_bytes()); // modification_time
    write_u32(&mut payload, timescale);
    write_u32(&mut payload, duration.min(u32::MAX as u64) as u32);
    write_u32(&mut payload, 0x0001_0000); // rate 1.0
    write_u16(&mut payload, 0x0100); // volume 1.0
    payload.extend_from_slice(&[0u8; 10]);
    payload.extend_from_slice(&matrix());
    payload.extend_from_slice(&[0u8; 24]);
    write_u32(&mut payload, 2); // next_track_ID
    let mut out = Vec::new();
    write_full_box(&mut out, b"mvhd", 0, 0, &payload);
    out
}

fn tkhd(track_id: u32, duration: u64, width: u32, height: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&0u32.to_be_bytes());
    payload.extend_from_slice(&0u32.to_be_bytes());
    write_u32(&mut payload, track_id);
    write_u32(&mut payload, 0); // reserved
    write_u32(&mut payload, duration.min(u32::MAX as u64) as u32);
    payload.extend_from_slice(&[0u8; 8]); // reserved
    write_u16(&mut payload, 0); // layer
    write_u16(&mut payload, 0); // alternate_group
    write_u16(&mut payload, 0); // volume (video)
    write_u16(&mut payload, 0); // reserved
    payload.extend_from_slice(&matrix());
    write_u32(&mut payload, width << 16);
    write_u32(&mut payload, height << 16);
    let mut out = Vec::new();
    // flags: enabled | in_movie
    write_full_box(&mut out, b"tkhd", 0, 0x000003, &payload);
    out
}

fn mdhd(timescale: u32, duration: u64) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&0u32.to_be_bytes());
    payload.extend_from_slice(&0u32.to_be_bytes());
    write_u32(&mut payload, timescale);
    write_u32(&mut payload, duration.min(u32::MAX as u64) as u32);
    write_u16(&mut payload, 0x55c4); // und
    write_u16(&mut payload, 0);
    let mut out = Vec::new();
    write_full_box(&mut out, b"mdhd", 0, 0, &payload);
    out
}

fn hdlr() -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&0u32.to_be_bytes()); // pre_defined
    payload.extend_from_slice(b"vide");
    payload.extend_from_slice(&[0u8; 12]);
    payload.extend_from_slice(b"VideoHandler\0");
    let mut out = Vec::new();
    write_full_box(&mut out, b"hdlr", 0, 0, &payload);
    out
}

fn vmhd() -> Vec<u8> {
    let mut payload = vec![0u8; 8];
    payload[0..2].copy_from_slice(&1u16.to_be_bytes()); // graphics_mode
    let mut out = Vec::new();
    write_full_box(&mut out, b"vmhd", 0, 1, &payload);
    out
}

fn dinf() -> Vec<u8> {
    // dref: 一个 `url ` 全零（自包含）。
    let mut url = Vec::new();
    write_full_box(&mut url, b"url ", 0, 1, &[]);
    let mut dref_payload = Vec::new();
    write_u32(&mut dref_payload, 1);
    dref_payload.extend_from_slice(&url);
    let mut dref = Vec::new();
    write_full_box(&mut dref, b"dref", 0, 0, &dref_payload);
    let mut out = Vec::new();
    write_box(&mut out, b"dinf", &dref);
    out
}

fn avcc(sps: &[u8], pps: &[u8]) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.push(1); // configurationVersion
    // AVCProfileIndication / profile_compatibility / AVCLevelIndication 来自 SPS。
    payload.push(*sps.get(1).unwrap_or(&0x42));
    payload.push(*sps.get(2).unwrap_or(&0));
    payload.push(*sps.get(3).unwrap_or(&0x1e));
    payload.push(0xff); // 4 字节 NAL 长度前缀
    payload.push(0xe1); // numOfSequenceParameterSets
    write_u16(&mut payload, sps.len() as u16);
    payload.extend_from_slice(sps);
    payload.push(1); // numOfPictureParameterSets
    write_u16(&mut payload, pps.len() as u16);
    payload.extend_from_slice(pps);
    let mut out = Vec::new();
    write_box(&mut out, b"avcC", &payload);
    out
}

fn avc1(options: &MuxOptions) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&[0u8; 6]); // reserved
    write_u16(&mut payload, 1); // data_reference_index
    payload.extend_from_slice(&[0u8; 16]);
    write_u16(&mut payload, options.width as u16);
    write_u16(&mut payload, options.height as u16);
    write_u32(&mut payload, 0x0048_0000); // horizresolution 72dpi
    write_u32(&mut payload, 0x0048_0000); // vertresolution
    write_u32(&mut payload, 0); // reserved
    write_u16(&mut payload, 1); // frame_count
    payload.extend_from_slice(&[0u8; 32]); // compressorname
    write_u16(&mut payload, 0x0018); // depth
    write_u16(&mut payload, 0xffff); // pre_defined = -1
    payload.extend_from_slice(&avcc(&options.sps, &options.pps));
    let mut out = Vec::new();
    write_box(&mut out, b"avc1", &payload);
    out
}

fn stts(samples: &[EncodedSample]) -> Vec<u8> {
    // 游程编码：连续相同 duration 合并。
    let mut runs: Vec<(u32, u32)> = Vec::new();
    for sample in samples {
        let duration = sample.duration.min(u32::MAX as u64) as u32;
        match runs.last_mut() {
            Some((count, last)) if *last == duration => *count += 1,
            _ => runs.push((1, duration)),
        }
    }
    let mut payload = Vec::new();
    write_u32(&mut payload, runs.len() as u32);
    for (count, duration) in runs {
        write_u32(&mut payload, count);
        write_u32(&mut payload, duration);
    }
    let mut out = Vec::new();
    write_full_box(&mut out, b"stts", 0, 0, &payload);
    out
}

fn stss(samples: &[EncodedSample]) -> Option<Vec<u8>> {
    let keys: Vec<u32> = samples
        .iter()
        .enumerate()
        .filter(|(_, sample)| sample.keyframe)
        .map(|(index, _)| index as u32 + 1)
        .collect();
    if keys.is_empty() {
        return None;
    }
    let mut payload = Vec::new();
    write_u32(&mut payload, keys.len() as u32);
    for key in keys {
        write_u32(&mut payload, key);
    }
    let mut out = Vec::new();
    write_full_box(&mut out, b"stss", 0, 0, &payload);
    Some(out)
}

fn stsc() -> Vec<u8> {
    // 每个 chunk 一个 sample。
    let mut payload = Vec::new();
    write_u32(&mut payload, 1);
    write_u32(&mut payload, 1); // first_chunk
    write_u32(&mut payload, 1); // samples_per_chunk
    write_u32(&mut payload, 1); // sample_description_index
    let mut out = Vec::new();
    write_full_box(&mut out, b"stsc", 0, 0, &payload);
    out
}

fn stsz(samples: &[EncodedSample]) -> Vec<u8> {
    let mut payload = Vec::new();
    write_u32(&mut payload, 0); // sample_size = 0 → 逐样本
    write_u32(&mut payload, samples.len() as u32);
    for sample in samples {
        write_u32(&mut payload, sample.size);
    }
    let mut out = Vec::new();
    write_full_box(&mut out, b"stsz", 0, 0, &payload);
    out
}

fn stco(offsets: &[u32]) -> Vec<u8> {
    let mut payload = Vec::new();
    write_u32(&mut payload, offsets.len() as u32);
    for offset in offsets {
        write_u32(&mut payload, *offset);
    }
    let mut out = Vec::new();
    write_full_box(&mut out, b"stco", 0, 0, &payload);
    out
}

/// 构造完整 `moov`。`chunk_offsets` 是每个样本相对 `mdat` 数据区的偏移基准。
fn moov(options: &MuxOptions, samples: &[EncodedSample], duration: u64) -> Vec<u8> {
    let mut stbl_payload = Vec::new();
    let mut stsd_payload = Vec::new();
    write_u32(&mut stsd_payload, 1);
    stsd_payload.extend_from_slice(&avc1(options));
    let mut stsd = Vec::new();
    write_full_box(&mut stsd, b"stsd", 0, 0, &stsd_payload);

    stbl_payload.extend_from_slice(&stsd);
    stbl_payload.extend_from_slice(&stts(samples));
    if let Some(stss_box) = stss(samples) {
        stbl_payload.extend_from_slice(&stss_box);
    }
    stbl_payload.extend_from_slice(&stsc());
    stbl_payload.extend_from_slice(&stsz(samples));
    // 占位：真实偏移在 `write_mp4` 里由调用方给出。
    stbl_payload.extend_from_slice(&stco(&vec![0u32; samples.len()]));
    let mut stbl = Vec::new();
    write_box(&mut stbl, b"stbl", &stbl_payload);

    let mut minf_payload = Vec::new();
    minf_payload.extend_from_slice(&vmhd());
    minf_payload.extend_from_slice(&dinf());
    minf_payload.extend_from_slice(&stbl);
    let mut minf = Vec::new();
    write_box(&mut minf, b"minf", &minf_payload);

    let mut mdia_payload = Vec::new();
    mdia_payload.extend_from_slice(&mdhd(options.timescale, duration));
    mdia_payload.extend_from_slice(&hdlr());
    mdia_payload.extend_from_slice(&minf);
    let mut mdia = Vec::new();
    write_box(&mut mdia, b"mdia", &mdia_payload);

    let mut trak_payload = Vec::new();
    trak_payload.extend_from_slice(&tkhd(1, duration, options.width, options.height));
    trak_payload.extend_from_slice(&mdia);
    let mut trak = Vec::new();
    write_box(&mut trak, b"trak", &trak_payload);

    let mut moov_payload = Vec::new();
    moov_payload.extend_from_slice(&mvhd(options.timescale, duration));
    moov_payload.extend_from_slice(&trak);
    let mut out = Vec::new();
    write_box(&mut out, b"moov", &moov_payload);
    out
}

/// 把 `stco` 表里的偏移替换为真实值（`moov` 构造后再定位）。
fn patch_stco(moov: &mut [u8], offsets: &[u32]) {
    let position = moov
        .windows(4)
        .position(|window| window == b"stco")
        .map(|index| index + 4);
    let Some(start) = position else { return };
    // stco: version+flags(4) entry_count(4) entries...
    let entries = start + 8;
    for (index, offset) in offsets.iter().enumerate() {
        let at = entries + index * 4;
        if at + 4 > moov.len() {
            break;
        }
        moov[at..at + 4].copy_from_slice(&offset.to_be_bytes());
    }
}

/// 写出最终 MP4：`ftyp` + `moov`（Fast Start）+ `mdat`（从 spool 流式拷贝）。
///
/// `spool` 里的样本必须**已按 AVCC 长度前缀**写好，顺序与 `samples` 一致。
pub fn write_mp4(
    output: &Path,
    spool: &Path,
    options: &MuxOptions,
    samples: &[EncodedSample],
) -> Result<MuxResult, EncodeFailure> {
    if samples.is_empty() {
        return Err(EncodeFailure::new(
            EncodeStage::Mux,
            "recording-artifact-empty",
            "没有可封装的帧",
        ));
    }
    let duration: u64 = samples.iter().map(|sample| sample.duration).sum();
    let mut moov_bytes = moov(options, samples, duration);
    let header_len = ftyp().len() as u64 + moov_bytes.len() as u64 + 8;
    // 每个样本独占一个 chunk，偏移 = mdat 数据区起点 + 累计样本大小。
    let mut offsets = Vec::with_capacity(samples.len());
    let mut running = header_len;
    for sample in samples {
        offsets.push(u32::try_from(running).map_err(|_| {
            EncodeFailure::new(
                EncodeStage::Mux,
                "recording-artifact-too-large",
                "成片超过 4 GiB 寻址范围",
            )
        })?);
        running += sample.size as u64;
    }
    patch_stco(&mut moov_bytes, &offsets);

    let file = File::create(output).map_err(|error| {
        EncodeFailure::new(
            EncodeStage::Mux,
            "recording-artifact-create-failed",
            error.to_string(),
        )
    })?;
    let mut writer = BufWriter::new(file);
    writer
        .write_all(&ftyp())
        .and_then(|_| writer.write_all(&moov_bytes))
        .map_err(|error| {
            EncodeFailure::new(
                EncodeStage::Mux,
                "recording-artifact-write-failed",
                error.to_string(),
            )
        })?;

    // mdat box 头：大尺寸时用 64 位 largesize。
    let payload_len: u64 = samples.iter().map(|sample| sample.size as u64).sum();
    let mdat_len = 8 + payload_len;
    if mdat_len > u32::MAX as u64 {
        let mut header = Vec::new();
        write_u32(&mut header, 1);
        header.extend_from_slice(b"mdat");
        header.extend_from_slice(&mdat_len.to_be_bytes());
        writer.write_all(&header).map_err(|error| {
            EncodeFailure::new(
                EncodeStage::Mux,
                "recording-artifact-write-failed",
                error.to_string(),
            )
        })?;
    } else {
        let mut header = Vec::new();
        write_u32(&mut header, mdat_len as u32);
        header.extend_from_slice(b"mdat");
        writer.write_all(&header).map_err(|error| {
            EncodeFailure::new(
                EncodeStage::Mux,
                "recording-artifact-write-failed",
                error.to_string(),
            )
        })?;
    }

    let mut spool_file = File::open(spool).map_err(|error| {
        EncodeFailure::new(
            EncodeStage::Mux,
            "recording-artifact-unreadable",
            error.to_string(),
        )
    })?;
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = spool_file.read(&mut buffer).map_err(|error| {
            EncodeFailure::new(
                EncodeStage::Mux,
                "recording-artifact-unreadable",
                error.to_string(),
            )
        })?;
        if read == 0 {
            break;
        }
        writer.write_all(&buffer[..read]).map_err(|error| {
            EncodeFailure::new(
                EncodeStage::Mux,
                "recording-artifact-write-failed",
                error.to_string(),
            )
        })?;
    }
    writer.flush().map_err(|error| {
        EncodeFailure::new(
            EncodeStage::Mux,
            "recording-artifact-write-failed",
            error.to_string(),
        )
    })?;
    drop(writer);

    let size_bytes = std::fs::metadata(output)
        .map_err(|error| {
            EncodeFailure::new(
                EncodeStage::Mux,
                "recording-artifact-unreadable",
                error.to_string(),
            )
        })?
        .len();
    Ok(MuxResult {
        size_bytes,
        duration_units: duration,
        frame_count: samples.len() as u64,
    })
}

/// 把一条 AVCC 样本（多个 NAL，带长度前缀）追加到 spool，返回写入字节数。
pub fn append_sample(spool: &mut impl Write, nals: &[Vec<u8>]) -> Result<u32, EncodeFailure> {
    let mut written = 0u32;
    for nal in nals {
        let len = u32::try_from(nal.len()).map_err(|_| {
            EncodeFailure::new(
                EncodeStage::Encode,
                "recording-nal-too-large",
                "NAL 超过 4 GiB",
            )
        })?;
        spool
            .write_all(&len.to_be_bytes())
            .and_then(|_| spool.write_all(nal))
            .map_err(|error| {
                EncodeFailure::new(
                    EncodeStage::Encode,
                    "recording-artifact-write-failed",
                    error.to_string(),
                )
            })?;
        written += 4 + len;
    }
    Ok(written)
}

/// 便捷入口：给定 spool 路径计算摘要（供成片自查与宿主复核对比）。
pub fn spool_digest(path: &Path) -> Result<String, EncodeFailure> {
    let bytes = std::fs::read(path).map_err(|error| {
        EncodeFailure::new(
            EncodeStage::Mux,
            "recording-artifact-unreadable",
            error.to_string(),
        )
    })?;
    Ok(sha256_hex(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> MuxOptions {
        MuxOptions {
            width: 64,
            height: 48,
            timescale: 30,
            // 最小可用的 SPS/PPS 形状（只用于结构校验，不用于解码）。
            sps: vec![
                0x67, 0x42, 0xc0, 0x1e, 0xda, 0x02, 0x80, 0xb7, 0xfe, 0x5c, 0x05, 0x05, 0x05, 0x02,
            ],
            pps: vec![0x68, 0xce, 0x3c, 0x80],
        }
    }

    fn sample(pts: u64, duration: u64, keyframe: bool, size: u32) -> EncodedSample {
        EncodedSample {
            pts,
            duration,
            keyframe,
            size,
        }
    }

    #[test]
    fn writes_fast_start_structure() {
        let dir = std::env::temp_dir().join("wo-mux-fast-start");
        std::fs::create_dir_all(&dir).expect("dir");
        let spool = dir.join("spool.bin");
        let samples = vec![sample(0, 1, true, 4), sample(1, 1, false, 4)];
        {
            let mut file = File::create(&spool).expect("spool");
            for top in 0..2 {
                append_sample(&mut file, &[vec![top as u8, 1, 2, 3]]).expect("append");
            }
        }
        let output = dir.join("out.mp4");
        let result = write_mp4(&output, &spool, &options(), &samples).expect("mux");
        assert_eq!(result.frame_count, 2);
        assert_eq!(result.duration_units, 2);

        let bytes = std::fs::read(&output).expect("read");
        let ftyp = bytes.windows(4).position(|w| w == b"ftyp").expect("ftyp");
        let moov = bytes.windows(4).position(|w| w == b"moov").expect("moov");
        let mdat = bytes.windows(4).position(|w| w == b"mdat").expect("mdat");
        assert!(ftyp < moov, "ftyp 应在 moov 前");
        assert!(moov < mdat, "Fast Start：moov 必须在 mdat 之前");
        // stco 偏移应指向 mdat 数据区。
        let stco = bytes.windows(4).position(|w| w == b"stco").expect("stco");
        let entries = stco + 4 + 8;
        let first = u32::from_be_bytes(bytes[entries..entries + 4].try_into().unwrap());
        // `position` 命中的是 box 的 type 字段（box 起始 +4），数据区在 type 之后 +4。
        assert_eq!(
            first as usize,
            mdat + 4,
            "第一个样本偏移应等于 mdat 数据区起点"
        );
        assert_eq!(result.size_bytes, bytes.len() as u64);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_empty_sample_list() {
        let dir = std::env::temp_dir().join("wo-mux-empty");
        std::fs::create_dir_all(&dir).expect("dir");
        let spool = dir.join("spool.bin");
        std::fs::write(&spool, b"").expect("write");
        let error = write_mp4(&dir.join("out.mp4"), &spool, &options(), &[]).expect_err("empty");
        assert_eq!(error.code, "recording-artifact-empty");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn writes_keyframe_table_only_when_present() {
        let dir = std::env::temp_dir().join("wo-mux-keyframes");
        std::fs::create_dir_all(&dir).expect("dir");
        let spool = dir.join("spool.bin");
        std::fs::write(&spool, vec![0u8; 8]).expect("write");
        let with_key = vec![sample(0, 1, true, 4), sample(1, 1, false, 4)];
        let output = dir.join("with.mp4");
        write_mp4(&output, &spool, &options(), &with_key).expect("mux");
        let bytes = std::fs::read(&output).expect("read");
        assert!(bytes.windows(4).any(|w| w == b"stss"));
        assert!(bytes.windows(4).any(|w| w == b"avcC"));
        assert!(bytes.windows(4).any(|w| w == b"avc1"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn duration_is_the_sum_of_sample_durations() {
        let dir = std::env::temp_dir().join("wo-mux-duration");
        std::fs::create_dir_all(&dir).expect("dir");
        let spool = dir.join("spool.bin");
        std::fs::write(&spool, vec![0u8; 12]).expect("write");
        // 30fps 下 1 秒 = 30 个 unit；末帧可短于 1 个 unit 表达为 timescale 精度内的整数。
        let samples = vec![
            sample(0, 1, true, 4),
            sample(1, 1, false, 4),
            sample(2, 1, false, 4),
        ];
        let result = write_mp4(&dir.join("out.mp4"), &spool, &options(), &samples).expect("mux");
        assert_eq!(result.duration_units, 3);
        std::fs::remove_dir_all(&dir).ok();
    }
}
