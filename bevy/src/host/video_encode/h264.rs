//! RGBA → I420 → H.264（OpenH264）编码；输出可直接复用为 MP4 sample。

use openh264::encoder::{BitRate, Encoder, EncoderConfig, FrameRate, FrameType, RateControlMode};
use openh264::formats::YUVSource;

/// 一帧编码结果：AVCC 形式的 sample（已去掉 Annex-B 起始码并改为长度前缀）。
pub struct EncodedIndexFrame {
    pub bytes: Vec<u8>,
    pub keyframe: bool,
}

pub struct EncodedVideo {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub frames: usize,
    pub samples: Vec<EncodedIndexFrame>,
    pub sps: Vec<u8>,
    pub pps: Vec<u8>,
}

struct I420Frame {
    width: usize,
    height: usize,
    y: Vec<u8>,
    u: Vec<u8>,
    v: Vec<u8>,
}

impl YUVSource for I420Frame {
    fn dimensions(&self) -> (usize, usize) {
        (self.width, self.height)
    }
    fn strides(&self) -> (usize, usize, usize) {
        (self.width, self.width / 2, self.width / 2)
    }
    fn y(&self) -> &[u8] {
        &self.y
    }
    fn u(&self) -> &[u8] {
        &self.u
    }
    fn v(&self) -> &[u8] {
        &self.v
    }
}

/// BT.601 全范围近似转换；编码只用于取景展示与参考，不做色彩管线回归。
fn rgba_to_i420(rgba: &[u8], width: usize, height: usize) -> Result<I420Frame, String> {
    if rgba.len() != width * height * 4 {
        return Err("rgba frame size does not match width*height*4".to_owned());
    }
    let chroma_width = (width + 1) / 2;
    let chroma_height = (height + 1) / 2;
    let mut y = vec![0u8; width * height];
    let mut u = vec![0u8; chroma_width * chroma_height];
    let mut v = vec![0u8; chroma_width * chroma_height];

    for row in 0..height {
        for col in 0..width {
            let index = (row * width + col) * 4;
            let r = rgba[index] as f32;
            let g = rgba[index + 1] as f32;
            let b = rgba[index + 2] as f32;
            let luma = 0.299 * r + 0.587 * g + 0.114 * b;
            y[row * width + col] = luma.round().clamp(0.0, 255.0) as u8;
            if row % 2 == 0 && col % 2 == 0 {
                let cb = -0.168_736 * r - 0.331_264 * g + 0.5 * b + 128.0;
                let cr = 0.5 * r - 0.418_688 * g - 0.081_312 * b + 128.0;
                let chroma = (row / 2) * chroma_width + col / 2;
                u[chroma] = cb.round().clamp(0.0, 255.0) as u8;
                v[chroma] = cr.round().clamp(0.0, 255.0) as u8;
            }
        }
    }

    Ok(I420Frame { width, height, y, u, v })
}

pub struct H264Encoder {
    encoder: Encoder,
    width: u32,
    height: u32,
    fps: u32,
    samples: Vec<EncodedIndexFrame>,
    sps: Vec<u8>,
    pps: Vec<u8>,
}

impl H264Encoder {
    pub fn new(width: u32, height: u32, fps: u32) -> Result<Self, String> {
        if width == 0 || height == 0 {
            return Err("video width/height must be positive".to_owned());
        }
        if fps == 0 || fps > super::MAX_VIDEO_FPS {
            return Err("video fps out of range".to_owned());
        }
        // 奇数尺寸无法组成 4:2:0 宏块；向上取偶，同时保留真实输出尺寸由请求决定。
        let width = width + (width % 2);
        let height = height + (height % 2);
        let config = EncoderConfig::new()
            .bitrate(BitRate::from_bps(8_000_000))
            .max_frame_rate(FrameRate::from_hz(fps as f32))
            .rate_control_mode(RateControlMode::Quality);
        let encoder = Encoder::with_api_config(openh264::OpenH264API::from_source(), config)
            .map_err(|error| error.to_string())?;
        Ok(Self { encoder, width, height, fps, samples: Vec::new(), sps: Vec::new(), pps: Vec::new() })
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn fps(&self) -> u32 {
        self.fps
    }

    /// 编码一帧 RGBA（自顶向下）。返回该帧是否为关键帧。
    pub fn push_rgba(&mut self, rgba: &[u8]) -> Result<bool, String> {
        let frame = rgba_to_i420(rgba, self.width as usize, self.height as usize)?;
        let bitstream = self.encoder.encode(&frame).map_err(|error| error.to_string())?;
        let keyframe = matches!(bitstream.frame_type(), FrameType::IDR | FrameType::I);
        let mut sample = Vec::new();
        for layer_index in 0..bitstream.num_layers() {
            let Some(layer) = bitstream.layer(layer_index) else { continue };
            for nal_index in 0..layer.nal_count() {
                let Some(raw) = layer.nal_unit(nal_index) else { continue };
                for nal in split_annex_b(raw) {
                    if nal.is_empty() {
                        continue;
                    }
                    let nal_type = nal[0] & 0x1f;
                    match nal_type {
                        7 => {
                            if self.sps.is_empty() {
                                self.sps = nal.to_vec();
                            }
                        }
                        8 => {
                            if self.pps.is_empty() {
                                self.pps = nal.to_vec();
                            }
                        }
                        // 访问单元分隔符对 MP4 无意义。
                        9 => {}
                        _ => {
                            sample.extend_from_slice(&(nal.len() as u32).to_be_bytes());
                            sample.extend_from_slice(nal);
                        }
                    }
                }
            }
        }
        if !sample.is_empty() {
            self.samples.push(EncodedIndexFrame { bytes: sample, keyframe });
        }
        Ok(keyframe)
    }

    pub fn frame_count(&self) -> usize {
        self.samples.len()
    }

    pub fn finish(self) -> Result<EncodedVideo, String> {
        if self.samples.is_empty() {
            return Err("no encoded frames".to_owned());
        }
        if self.sps.is_empty() || self.pps.is_empty() {
            return Err("encoder did not emit SPS/PPS".to_owned());
        }
        Ok(EncodedVideo {
            width: self.width,
            height: self.height,
            fps: self.fps,
            frames: self.samples.len(),
            samples: self.samples,
            sps: self.sps,
            pps: self.pps,
        })
    }
}

/// 将 Annex-B NAL（可能带 3/4 字节起始码）拆成裸 NAL。
fn split_annex_b(input: &[u8]) -> Vec<&[u8]> {
    let mut units = Vec::new();
    let mut start: Option<usize> = None;
    let mut index = 0;
    while index + 2 < input.len() {
        let three = input[index] == 0 && input[index + 1] == 0 && input[index + 2] == 1;
        let four = index + 3 < input.len()
            && input[index] == 0
            && input[index + 1] == 0
            && input[index + 2] == 0
            && input[index + 3] == 1;
        if four || three {
            if let Some(begin) = start {
                let end = index;
                if end > begin {
                    units.push(&input[begin..end]);
                }
            }
            index += if four { 4 } else { 3 };
            start = Some(index);
        } else {
            index += 1;
        }
    }
    if let Some(begin) = start {
        if begin < input.len() {
            units.push(&input[begin..]);
        }
    } else if !input.is_empty() {
        units.push(input);
    }
    units
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_annex_b_start_codes() {
        let data = [0u8, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3];
        let units = split_annex_b(&data);
        assert_eq!(units.len(), 2);
        assert_eq!(units[0], &[0x67, 1, 2]);
        assert_eq!(units[1], &[0x68, 3]);
    }
}
