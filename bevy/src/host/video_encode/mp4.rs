//! 最小 MP4（AVC）封装器：单视频轨、非分片、样本即 AVCC 字节。
//!
//! 只写动态镜头需要的字段：ftyp / mdat / moov（mvhd, trak(tkhd, mdia(mdhd, hdlr,
//! minf(vmhd, dinf(dref), stbl(stsd(avc1(avcC)), stts, stss, stsc, stsz, stco))))）。
//! 时长与帧数直接来自编码结果，不使用估算值。

use super::h264::EncodedVideo;

const MOVIE_TIMESCALE: u32 = 1000;

fn boxed(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + 8);
    out.extend_from_slice(&((body.len() + 8) as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(body);
    out
}

fn full_box(kind: &[u8; 4], version: u8, flags: u32, body: &[u8]) -> Vec<u8> {
    let mut inner = Vec::with_capacity(body.len() + 4);
    inner.push(version);
    inner.extend_from_slice(&[
        ((flags >> 16) & 0xff) as u8,
        ((flags >> 8) & 0xff) as u8,
        (flags & 0xff) as u8,
    ]);
    inner.extend_from_slice(body);
    boxed(kind, &inner)
}

fn push_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_be_bytes());
}

fn push_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_be_bytes());
}

fn identity_matrix() -> Vec<u8> {
    let mut out = Vec::with_capacity(36);
    let values: [u32; 9] = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000];
    for value in values {
        push_u32(&mut out, value);
    }
    out
}

pub fn build_mp4(video: &EncodedVideo) -> Result<Vec<u8>, String> {
    if video.samples.is_empty() || video.fps == 0 || video.width == 0 || video.height == 0 {
        return Err("incomplete video for mp4 muxing".to_owned());
    }
    let frames = video.samples.len() as u32;
    let duration_ms = ((frames as u64 * MOVIE_TIMESCALE as u64) / video.fps as u64).max(1) as u32;

    let ftyp_body = {
        let mut body = Vec::new();
        body.extend_from_slice(b"isom");
        push_u32(&mut body, 512);
        body.extend_from_slice(b"isomiso2avc1mp41");
        body
    };
    let ftyp = boxed(b"ftyp", &ftyp_body);

    let mut mdat_payload = Vec::new();
    for sample in &video.samples {
        mdat_payload.extend_from_slice(&sample.bytes);
    }
    let mut mdat = Vec::with_capacity(mdat_payload.len() + 8);
    mdat.extend_from_slice(&((mdat_payload.len() + 8) as u32).to_be_bytes());
    mdat.extend_from_slice(b"mdat");
    mdat.extend_from_slice(&mdat_payload);
    let chunk_offset = (ftyp.len() + 8) as u32;

    // mvhd
    let mut mvhd_body = Vec::new();
    push_u32(&mut mvhd_body, 0);
    push_u32(&mut mvhd_body, 0);
    push_u32(&mut mvhd_body, MOVIE_TIMESCALE);
    push_u32(&mut mvhd_body, duration_ms);
    push_u32(&mut mvhd_body, 0x0001_0000);
    push_u16(&mut mvhd_body, 0x0100);
    mvhd_body.extend_from_slice(&[0u8; 10]);
    mvhd_body.extend_from_slice(&identity_matrix());
    mvhd_body.extend_from_slice(&[0u8; 24]);
    push_u32(&mut mvhd_body, 2);
    let mvhd = full_box(b"mvhd", 0, 0, &mvhd_body);

    // tkhd
    let mut tkhd_body = Vec::new();
    push_u32(&mut tkhd_body, 0);
    push_u32(&mut tkhd_body, 0);
    push_u32(&mut tkhd_body, 1);
    push_u32(&mut tkhd_body, 0);
    push_u32(&mut tkhd_body, duration_ms);
    tkhd_body.extend_from_slice(&[0u8; 8]);
    push_u16(&mut tkhd_body, 0);
    push_u16(&mut tkhd_body, 0);
    push_u16(&mut tkhd_body, 0);
    push_u16(&mut tkhd_body, 0);
    tkhd_body.extend_from_slice(&identity_matrix());
    push_u32(&mut tkhd_body, video.width << 16);
    push_u32(&mut tkhd_body, video.height << 16);
    let tkhd = full_box(b"tkhd", 0, 7, &tkhd_body);

    // mdhd
    let mut mdhd_body = Vec::new();
    push_u32(&mut mdhd_body, 0);
    push_u32(&mut mdhd_body, 0);
    push_u32(&mut mdhd_body, video.fps);
    push_u32(&mut mdhd_body, frames);
    push_u16(&mut mdhd_body, 0x55c4);
    push_u16(&mut mdhd_body, 0);
    let mdhd = full_box(b"mdhd", 0, 0, &mdhd_body);

    // hdlr
    let mut hdlr_body = Vec::new();
    push_u32(&mut hdlr_body, 0);
    hdlr_body.extend_from_slice(b"vide");
    hdlr_body.extend_from_slice(&[0u8; 12]);
    hdlr_body.extend_from_slice(b"VideoHandler\0");
    let hdlr = full_box(b"hdlr", 0, 0, &hdlr_body);

    // vmhd
    let mut vmhd_body = Vec::new();
    push_u16(&mut vmhd_body, 0);
    push_u16(&mut vmhd_body, 0);
    push_u16(&mut vmhd_body, 0);
    push_u16(&mut vmhd_body, 0);
    let vmhd = full_box(b"vmhd", 0, 1, &vmhd_body);

    // dinf/dref/url
    let url = full_box(b"url ", 0, 1, &[]);
    let mut dref_body = Vec::new();
    push_u32(&mut dref_body, 1);
    dref_body.extend_from_slice(&url);
    let dref = full_box(b"dref", 0, 0, &dref_body);
    let dinf = boxed(b"dinf", &dref);

    // avcC
    let mut avcc_body = Vec::new();
    avcc_body.push(1);
    avcc_body.push(video.sps.get(1).copied().unwrap_or(0x42));
    avcc_body.push(video.sps.get(2).copied().unwrap_or(0));
    avcc_body.push(video.sps.get(3).copied().unwrap_or(0x1f));
    avcc_body.push(0xff);
    avcc_body.push(0xe1);
    push_u16(&mut avcc_body, video.sps.len() as u16);
    avcc_body.extend_from_slice(&video.sps);
    avcc_body.push(1);
    push_u16(&mut avcc_body, video.pps.len() as u16);
    avcc_body.extend_from_slice(&video.pps);
    let avcc = boxed(b"avcC", &avcc_body);

    // avc1
    let mut avc1_body = Vec::new();
    avc1_body.extend_from_slice(&[0u8; 6]);
    push_u16(&mut avc1_body, 1);
    avc1_body.extend_from_slice(&[0u8; 16]);
    push_u16(&mut avc1_body, video.width as u16);
    push_u16(&mut avc1_body, video.height as u16);
    push_u32(&mut avc1_body, 0x0048_0000);
    push_u32(&mut avc1_body, 0x0048_0000);
    push_u32(&mut avc1_body, 0);
    push_u16(&mut avc1_body, 1);
    let mut name = [0u8; 32];
    let label = b"Woohaa camera shot";
    name[..label.len()].copy_from_slice(label);
    avc1_body.extend_from_slice(&name);
    push_u16(&mut avc1_body, 0x0018);
    push_u16(&mut avc1_body, 0xffff);
    avc1_body.extend_from_slice(&avcc);
    let avc1 = boxed(b"avc1", &avc1_body);

    let mut stsd_body = Vec::new();
    push_u32(&mut stsd_body, 1);
    stsd_body.extend_from_slice(&avc1);
    let stsd = full_box(b"stsd", 0, 0, &stsd_body);

    let mut stts_body = Vec::new();
    push_u32(&mut stts_body, 1);
    push_u32(&mut stts_body, frames);
    push_u32(&mut stts_body, 1);
    let stts = full_box(b"stts", 0, 0, &stts_body);

    let keyframes: Vec<u32> = video
        .samples
        .iter()
        .enumerate()
        .filter_map(|(index, sample)| sample.keyframe.then_some(index as u32 + 1))
        .collect();
    let mut stss_body = Vec::new();
    push_u32(&mut stss_body, keyframes.len() as u32);
    for index in &keyframes {
        push_u32(&mut stss_body, *index);
    }
    let stss = full_box(b"stss", 0, 0, &stss_body);

    let mut stsc_body = Vec::new();
    push_u32(&mut stsc_body, 1);
    push_u32(&mut stsc_body, 1);
    push_u32(&mut stsc_body, frames);
    push_u32(&mut stsc_body, 1);
    let stsc = full_box(b"stsc", 0, 0, &stsc_body);

    let mut stsz_body = Vec::new();
    push_u32(&mut stsz_body, 0);
    push_u32(&mut stsz_body, frames);
    for sample in &video.samples {
        push_u32(&mut stsz_body, sample.bytes.len() as u32);
    }
    let stsz = full_box(b"stsz", 0, 0, &stsz_body);

    let mut stco_body = Vec::new();
    push_u32(&mut stco_body, 1);
    push_u32(&mut stco_body, chunk_offset);
    let stco = full_box(b"stco", 0, 0, &stco_body);

    let mut stbl_body = Vec::new();
    for child in [stsd, stts, stss, stsc, stsz, stco] {
        stbl_body.extend_from_slice(&child);
    }
    let stbl = boxed(b"stbl", &stbl_body);

    let mut minf_body = Vec::new();
    for child in [vmhd, dinf, stbl] {
        minf_body.extend_from_slice(&child);
    }
    let minf = boxed(b"minf", &minf_body);

    let mut mdia_body = Vec::new();
    for child in [mdhd, hdlr, minf] {
        mdia_body.extend_from_slice(&child);
    }
    let mdia = boxed(b"mdia", &mdia_body);

    let mut trak_body = Vec::new();
    trak_body.extend_from_slice(&tkhd);
    trak_body.extend_from_slice(&mdia);
    let trak = boxed(b"trak", &trak_body);

    let mut moov_body = Vec::new();
    moov_body.extend_from_slice(&mvhd);
    moov_body.extend_from_slice(&trak);
    let moov = boxed(b"moov", &moov_body);

    let mut out = Vec::with_capacity(ftyp.len() + mdat.len() + moov.len());
    out.extend_from_slice(&ftyp);
    out.extend_from_slice(&mdat);
    out.extend_from_slice(&moov);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video_encode::h264::EncodedIndexFrame;

    fn u32_at(bytes: &[u8], offset: usize) -> u32 {
        u32::from_be_bytes([bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]])
    }

    fn boxes(bytes: &[u8], start: usize, end: usize) -> Vec<(String, usize, usize, usize)> {
        let mut out = Vec::new();
        let mut offset = start;
        while offset + 8 <= end {
            let size = u32_at(bytes, offset) as usize;
            if size < 8 || offset + size > end {
                break;
            }
            let kind = String::from_utf8_lossy(&bytes[offset + 4..offset + 8]).to_string();
            out.push((kind, offset, offset + size, offset + 8));
            offset += size;
        }
        out
    }

    fn find<'a>(list: &'a [(String, usize, usize, usize)], kind: &str) -> Option<&'a (String, usize, usize, usize)> {
        list.iter().find(|entry| entry.0 == kind)
    }

    #[test]
    fn writes_a_readable_single_track_mp4() {
        let video = EncodedVideo {
            width: 320,
            height: 180,
            fps: 24,
            frames: 48,
            samples: (0..48)
                .map(|index| EncodedIndexFrame {
                    bytes: vec![0, 0, 0, 2, 0x65, index as u8],
                    keyframe: index == 0,
                })
                .collect(),
            sps: vec![0x67, 0x42, 0x00, 0x1f],
            pps: vec![0x68, 0xce],
        };
        let mp4 = build_mp4(&video).expect("mp4");
        let top = boxes(&mp4, 0, mp4.len());
        assert!(find(&top, "ftyp").is_some());
        assert!(find(&top, "mdat").is_some());
        let moov = find(&top, "moov").expect("moov");
        let moov_children = boxes(&mp4, moov.3, moov.2);
        let trak = find(&moov_children, "trak").expect("trak");
        let trak_children = boxes(&mp4, trak.3, trak.2);
        let mdia = find(&trak_children, "mdia").expect("mdia");
        let mdia_children = boxes(&mp4, mdia.3, mdia.2);
        let mdhd = find(&mdia_children, "mdhd").expect("mdhd");
        assert_eq!(u32_at(&mp4, mdhd.3 + 12), 24, "timescale == fps");
        assert_eq!(u32_at(&mp4, mdhd.3 + 16), 48, "duration == frames");
        let minf = find(&mdia_children, "minf").expect("minf");
        let minf_children = boxes(&mp4, minf.3, minf.2);
        let stbl = find(&minf_children, "stbl").expect("stbl");
        let stbl_children = boxes(&mp4, stbl.3, stbl.2);
        let stsz = find(&stbl_children, "stsz").expect("stsz");
        assert_eq!(u32_at(&mp4, stsz.3 + 8), 48, "sample count");
    }
}
