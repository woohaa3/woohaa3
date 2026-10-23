//! 本域的唯一滤镜清单：逐条登记生产命令、中文名、归类、交互形态与资源需求。
//!
//! 参数 schema **不手写**：直接取 [`photocraft_engine::commands`] 注册表里同一条命令的参数
//! 记法（`{"radius":0.1..1000=1,"quality":"draft|good|best"="good"}`）解析成有界类型，因此
//! 上游参数范围、默认值与选择项一旦变化，本域清单随之变化，不会出现「面板写的范围和内核
//! 不一致」这种漂移。
//!
//! 未登记的滤镜（液化、智能滤镜转换、插件、以及任何上游新增但本 change 未验收的项）不会
//! 出现在清单里，`begin` 会明确拒绝，而不是静默按默认值执行。

use serde_json::{Value, json};

use crate::error::{EditorError, Result};

/// 本域统一的参数/几何拒绝：`filter.draft` 加上可直接展示的中文原因。
pub(crate) fn bad(message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed { id: "filter.draft".into(), message: message.to_string() }
}

/// 一次 Filter Gallery 组合最多的效果层数（与上游同值，上游也会再次拒绝）。
pub const MAX_EFFECTS: usize = 32;
/// 模糊画廊/光照等控制点的上限。
pub const MAX_PINS: usize = 16;
/// 消失点透视平面的上限。
pub const MAX_PLANES: usize = 8;
/// 单条命令的参数项上限（防御异常清单）。
pub const MAX_PARAMS: usize = 96;
/// JSON 型资源参数一次允许的数组项上限（位移点、约束、克隆路径等）。
pub const MAX_RESOURCE_POINTS: usize = 64;

/// 交互形态：决定面板给哪种编辑器和提交时的额外校验。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// 普通参数滤镜：滑杆/选择项即可。
    Simple,
    /// 带冻结 seed 的随机滤镜。
    Random,
    /// 单个画廊滤镜（参数来自画廊清单）。
    Gallery,
    /// 滤镜库组合：`effects` 效果栈。
    GalleryStack,
    /// 模糊画廊：图内控制点/路径。
    BlurGallery,
    /// 摄影校正：镜头校正、自适应广角。
    Lens,
    /// RGB 摄影调节（Camera Raw 滤镜，不是 RAW 解码）。
    CameraRaw,
    /// 消失点透视平面。
    VanishingPoint,
}

/// 一条已登记的滤镜命令。
pub struct Entry {
    pub id: &'static str,
    /// 界面中文名。
    pub label: &'static str,
    /// 面板归类（中文）。
    pub category: &'static str,
    pub kind: Kind,
    /// 需要位移图等外部资源。
    pub needs_map: bool,
}

const fn e(id: &'static str, label: &'static str, category: &'static str, kind: Kind) -> Entry {
    Entry { id, label, category, kind, needs_map: false }
}
const fn map(mut entry: Entry) -> Entry {
    entry.needs_map = true;
    entry
}

use Kind::{BlurGallery, CameraRaw, Gallery, GalleryStack, Lens, Random, Simple, VanishingPoint};

/// 已验收的滤镜命令清单（顺序即面板顺序）。
pub static ENTRIES: &[Entry] = &[
    // ---- U46 锐化 ----
    e("filter.sharpen.unsharpMask", "USM 锐化", "锐化", Simple),
    e("filter.sharpen.sharpen", "锐化", "锐化", Simple),
    e("filter.sharpen.sharpenMore", "进一步锐化", "锐化", Simple),
    e("filter.sharpen.sharpenEdges", "锐化边缘", "锐化", Simple),
    e("filter.sharpen.smartSharpen", "智能锐化", "锐化", Simple),
    // ---- U47 模糊 ----
    e("filter.blur.gaussianBlur", "高斯模糊", "模糊", Simple),
    e("filter.blur.blur", "模糊", "模糊", Simple),
    e("filter.blur.blurMore", "进一步模糊", "模糊", Simple),
    e("filter.blur.boxBlur", "方框模糊", "模糊", Simple),
    e("filter.blur.motionBlur", "动感模糊", "模糊", Simple),
    e("filter.blur.radialBlur", "径向模糊", "模糊", Simple),
    e("filter.blur.surfaceBlur", "表面模糊", "模糊", Simple),
    e("filter.blur.smartBlur", "特殊模糊", "模糊", Simple),
    e("filter.blur.shapeBlur", "形状模糊", "模糊", Simple),
    e("filter.blur.lensBlur", "镜头模糊", "模糊", Simple),
    e("filter.blur.average", "平均", "模糊", Simple),
    // ---- U47 杂色与降噪 ----
    e("filter.noise.addNoise", "添加杂色", "杂色", Random),
    e("filter.noise.despeckle", "去斑", "杂色", Simple),
    e("filter.noise.dustAndScratches", "蒙尘与划痕", "杂色", Simple),
    e("filter.noise.median", "中间值", "杂色", Simple),
    e("filter.noise.reduceNoise", "减少杂色", "杂色", Simple),
    // ---- U48 像素化 ----
    e("filter.pixelate.mosaic", "马赛克", "像素化", Simple),
    e("filter.pixelate.crystallize", "晶格化", "像素化", Random),
    e("filter.pixelate.colorHalftone", "彩色半调", "像素化", Simple),
    e("filter.pixelate.mezzotint", "铜版雕刻", "像素化", Random),
    e("filter.pixelate.pointillize", "点状化", "像素化", Random),
    e("filter.pixelate.facet", "彩块化", "像素化", Simple),
    e("filter.pixelate.fragment", "碎片", "像素化", Simple),
    // ---- U48 扭曲 ----
    e("filter.distort.wave", "波浪", "扭曲", Random),
    e("filter.distort.ripple", "波纹", "扭曲", Simple),
    e("filter.distort.twirl", "旋转扭曲", "扭曲", Simple),
    e("filter.distort.spherize", "球面化", "扭曲", Simple),
    e("filter.distort.pinch", "挤压", "扭曲", Simple),
    e("filter.distort.zigZag", "水波", "扭曲", Simple),
    e("filter.distort.shear", "切变", "扭曲", Simple),
    e("filter.distort.polarCoordinates", "极坐标", "扭曲", Simple),
    map(e("filter.distort.displace", "置换", "扭曲", Simple)),
    // ---- U48 风格化 ----
    e("filter.stylize.emboss", "浮雕效果", "风格化", Simple),
    e("filter.stylize.findEdges", "查找边缘", "风格化", Simple),
    e("filter.stylize.solarize", "曝光过度", "风格化", Simple),
    e("filter.stylize.diffuse", "扩散", "风格化", Random),
    e("filter.stylize.extrude", "凸出", "风格化", Random),
    e("filter.stylize.oilPaint", "油画", "风格化", Simple),
    e("filter.stylize.tiles", "拼贴", "风格化", Random),
    e("filter.stylize.traceContour", "等高线", "风格化", Simple),
    e("filter.stylize.wind", "风", "风格化", Random),
    // ---- U48 渲染 ----
    e("filter.render.clouds", "云彩", "渲染", Random),
    e("filter.render.differenceClouds", "分层云彩", "渲染", Random),
    e("filter.render.fibers", "纤维", "渲染", Random),
    e("filter.render.lensFlare", "镜头光晕", "渲染", Simple),
    e("filter.render.lightingEffects", "光照效果", "渲染", Simple),
    e("filter.render.relight", "重新光照", "渲染", Simple),
    e("filter.render.flame", "火焰", "渲染", Random),
    e("filter.render.pictureFrame", "画框", "渲染", Random),
    e("filter.render.tree", "树", "渲染", Random),
    // ---- U48 其他 ----
    e("filter.other.highPass", "高反差保留", "其他", Simple),
    e("filter.other.minimum", "最小值", "其他", Simple),
    e("filter.other.maximum", "最大值", "其他", Simple),
    e("filter.other.offset", "位移", "其他", Simple),
    e("filter.other.custom", "自定", "其他", Simple),
    e("filter.other.hsbHsl", "HSB/HSL", "其他", Simple),
    e("filter.other.colorToAlpha", "颜色转透明", "其他", Simple),
    // ---- U48 视频 ----
    e("filter.video.deInterlace", "逐行", "其他", Simple),
    e("filter.video.ntscColors", "NTSC 颜色", "其他", Simple),
    // ---- U49 滤镜库 ----
    e("filter.filterGallery", "滤镜库…", "滤镜库", GalleryStack),
    e("filter.gallery.coloredPencil", "彩色铅笔", "滤镜库", Gallery),
    e("filter.gallery.cutout", "剪贴画", "滤镜库", Gallery),
    e("filter.gallery.dryBrush", "干画笔", "滤镜库", Gallery),
    e("filter.gallery.filmGrain", "胶片颗粒", "滤镜库", Gallery),
    e("filter.gallery.fresco", "壁画", "滤镜库", Gallery),
    e("filter.gallery.neonGlow", "霓虹灯光", "滤镜库", Gallery),
    e("filter.gallery.paintDaubs", "绘画涂抹", "滤镜库", Gallery),
    e("filter.gallery.paletteKnife", "调色刀", "滤镜库", Gallery),
    e("filter.gallery.plasticWrap", "塑料包装", "滤镜库", Gallery),
    e("filter.gallery.posterEdges", "海报边缘", "滤镜库", Gallery),
    e("filter.gallery.roughPastels", "粗糙蜡笔", "滤镜库", Gallery),
    e("filter.gallery.smudgeStick", "涂抹棒", "滤镜库", Gallery),
    e("filter.gallery.sponge", "海绵", "滤镜库", Gallery),
    e("filter.gallery.underpainting", "底纹效果", "滤镜库", Gallery),
    e("filter.gallery.watercolor", "水彩", "滤镜库", Gallery),
    e("filter.gallery.accentedEdges", "强化的边缘", "滤镜库", Gallery),
    e("filter.gallery.angledStrokes", "成角的线条", "滤镜库", Gallery),
    e("filter.gallery.crosshatch", "阴影线", "滤镜库", Gallery),
    e("filter.gallery.darkStrokes", "深色线条", "滤镜库", Gallery),
    e("filter.gallery.inkOutlines", "油墨概况", "滤镜库", Gallery),
    e("filter.gallery.spatter", "喷溅", "滤镜库", Gallery),
    e("filter.gallery.sprayedStrokes", "喷色描边", "滤镜库", Gallery),
    e("filter.gallery.sumiE", "烟灰墨", "滤镜库", Gallery),
    e("filter.gallery.diffuseGlow", "扩散亮光", "滤镜库", Gallery),
    e("filter.gallery.glass", "玻璃", "滤镜库", Gallery),
    e("filter.gallery.oceanRipple", "海洋波纹", "滤镜库", Gallery),
    e("filter.gallery.basRelief", "基底凸现", "滤镜库", Gallery),
    e("filter.gallery.chalkCharcoal", "粉笔和炭笔", "滤镜库", Gallery),
    e("filter.gallery.charcoal", "炭笔", "滤镜库", Gallery),
    e("filter.gallery.chrome", "铬黄渐变", "滤镜库", Gallery),
    e("filter.gallery.conteCrayon", "绘图笔", "滤镜库", Gallery),
    e("filter.gallery.graphicPen", "影印", "滤镜库", Gallery),
    e("filter.gallery.halftonePattern", "半调图案", "滤镜库", Gallery),
    e("filter.gallery.notePaper", "便条纸", "滤镜库", Gallery),
    e("filter.gallery.photocopy", "照片复印", "滤镜库", Gallery),
    e("filter.gallery.plaster", "石膏效果", "滤镜库", Gallery),
    e("filter.gallery.reticulation", "网状", "滤镜库", Gallery),
    e("filter.gallery.stamp", "图章", "滤镜库", Gallery),
    e("filter.gallery.tornEdges", "撕边", "滤镜库", Gallery),
    e("filter.gallery.waterPaper", "水彩纸", "滤镜库", Gallery),
    e("filter.gallery.craquelure", "龟裂缝", "滤镜库", Gallery),
    e("filter.gallery.grain", "颗粒", "滤镜库", Gallery),
    e("filter.gallery.mosaicTiles", "马赛克拼贴", "滤镜库", Gallery),
    e("filter.gallery.patchwork", "拼缀图", "滤镜库", Gallery),
    e("filter.gallery.stainedGlass", "染色玻璃", "滤镜库", Gallery),
    e("filter.gallery.texturizer", "纹理化", "滤镜库", Gallery),
    e("filter.gallery.glowingEdges", "照亮边缘", "滤镜库", Gallery),
    // ---- U49 模糊画廊 ----
    e("filter.blurGallery.tiltShift", "移轴模糊", "模糊画廊", BlurGallery),
    e("filter.blurGallery.irisBlur", "光圈模糊", "模糊画廊", BlurGallery),
    e("filter.blurGallery.fieldBlur", "场景模糊", "模糊画廊", BlurGallery),
    e("filter.blurGallery.spinBlur", "旋转模糊", "模糊画廊", BlurGallery),
    e("filter.blurGallery.pathBlur", "路径模糊", "模糊画廊", BlurGallery),
    // ---- U49 摄影 ----
    e("filter.cameraRaw", "Camera Raw 滤镜…", "摄影", CameraRaw),
    e("filter.lensCorrection", "镜头校正", "摄影", Lens),
    e("filter.adaptiveWideAngle", "自适应广角", "摄影", Lens),
    e("filter.vanishingPoint", "消失点…", "摄影", VanishingPoint),
];

/// 命令是否读取前景/背景色。
///
/// 与上游同源，不在清单里手工打标：`filters_ext` 只对纤维、拼贴、点状化与画廊清单
/// 声明读取颜色的滤镜调色；云彩、火焰、树、画框等直接读 `Session::tools`，把它们标成
/// 参数化颜色会让内核收到未声明的 `foreground` 并拒绝整次预览。
pub fn uses_colours(id: &str) -> bool {
    matches!(id, "filter.render.fibers" | "filter.stylize.tiles" | "filter.pixelate.pointillize")
        || id == "filter.filterGallery"
        || id.strip_prefix("filter.gallery.")
            .and_then(photocraft_algo::GalleryFilter::from_key)
            .is_some_and(photocraft_algo::GalleryFilter::uses_colours)
}

/// 清单里是否有该命令。
pub fn entry(id: &str) -> Option<&'static Entry> {
    ENTRIES.iter().find(|entry| entry.id == id)
}

/// 命令是否属于本域已验收清单。
pub fn contains(id: &str) -> bool {
    entry(id).is_some()
}

/// 已验收命令 id（顺序稳定；供装配与测试核对）。
pub fn ids() -> impl Iterator<Item = &'static str> {
    ENTRIES.iter().map(|entry| entry.id)
}

/// 参数种类。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParamKind {
    Number,
    Integer,
    Choice,
    Bool,
    Color,
    /// 结构型参数（点、平面、路径、位移图…）：由本域几何校验处理，面板不画通用滑杆。
    Resource,
}

/// 一条参数的范围与默认值（来自上游命令记法）。
#[derive(Clone, Debug, PartialEq)]
pub struct ParamSpec {
    pub key: String,
    pub kind: ParamKind,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub default: Option<Value>,
    pub choices: Vec<String>,
}

impl ParamSpec {
    fn new(key: &str, kind: ParamKind) -> Self {
        Self { key: key.into(), kind, min: None, max: None, default: None, choices: Vec::new() }
    }

    /// JSON 形态（面板用）。
    pub fn to_json(&self) -> Value {
        json!({
            "key": self.key,
            "kind": match self.kind {
                ParamKind::Number => "number",
                ParamKind::Integer => "integer",
                ParamKind::Choice => "choice",
                ParamKind::Bool => "bool",
                ParamKind::Color => "color",
                ParamKind::Resource => "resource",
            },
            "min": self.min,
            "max": self.max,
            "default": self.default,
            "choices": self.choices,
        })
    }
}

/// 把命令的参数记法切成顶层字段（尊重大括号、中括号与引号）。
fn split_top(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut quoted = false;
    let mut current = String::new();
    for ch in text.chars() {
        match ch {
            '"' => {
                quoted = !quoted;
                current.push(ch);
            }
            '{' | '[' if !quoted => {
                depth += 1;
                current.push(ch);
            }
            '}' | ']' if !quoted => {
                depth -= 1;
                current.push(ch);
            }
            ',' if !quoted && depth == 0 => {
                out.push(std::mem::take(&mut current));
            }
            _ => current.push(ch),
        }
    }
    if !current.trim().is_empty() {
        out.push(current);
    }
    out
}

/// `"key":"a|b"="a"` / `"n":0.1..1000=1` / `"seed":u32=0` / `"b":bool` / `"c":color=#fff`
fn parse_field(field: &str) -> Option<ParamSpec> {
    let field = field.trim();
    if !field.starts_with('"') {
        return None;
    }
    let key_end = field[1..].find('"')? + 1;
    let key = &field[1..key_end];
    let rest = field[key_end + 1..].trim_start().strip_prefix(':')?.trim();
    if key.is_empty() {
        return None;
    }
    if rest.starts_with('"') {
        // 选择项："a|b" 或 "a|b"="default"
        let close = rest[1..].find('"')? + 1;
        let names = &rest[1..close];
        let default = rest[close + 1..].trim_start().strip_prefix('=').and_then(|tail| {
            let tail = tail.trim_start();
            let end = tail[1..].find('"')? + 1;
            Some(Value::String(tail[1..end].into()))
        });
        let mut spec = ParamSpec::new(key, ParamKind::Choice);
        spec.choices = names.split('|').map(str::to_string).collect();
        spec.default = default.or_else(|| spec.choices.first().map(|name| Value::String(name.clone())));
        return Some(spec);
    }
    if rest == "bool" {
        let mut spec = ParamSpec::new(key, ParamKind::Bool);
        spec.default = Some(Value::Bool(false));
        return Some(spec);
    }
    if rest.starts_with("bool=") {
        let mut spec = ParamSpec::new(key, ParamKind::Bool);
        spec.default = Some(Value::Bool(rest[5..].trim() == "true"));
        return Some(spec);
    }
    if rest.starts_with("color") {
        let mut spec = ParamSpec::new(key, ParamKind::Color);
        spec.default = rest.split('=').nth(1).map(|v| Value::String(v.trim().to_string()));
        return Some(spec);
    }
    if let Some(value) = rest.strip_prefix("u32") {
        let mut spec = ParamSpec::new(key, ParamKind::Integer);
        spec.min = Some(0.0);
        spec.max = Some(f64::from(u32::MAX));
        spec.default = value.split('=').nth(1).and_then(|v| v.trim().parse::<u64>().ok()).map(|v| json!(v));
        return Some(spec);
    }
    // 带单位的数值：`px=0` / `mm=0` / `deg=90` / `%=-5`。
    //
    // 这些字段内核是按普通数字读的（`f(p, "horizontal", …)`、`num(p, "focalLength", …)`），
    // 所以必须当数字画滑杆；当成 `Resource` 会让面板跳过它，用户拿到的默认参数里干脆没有这个
    // 字段——位移滤镜因此一开始就是「水平/垂直都为 0」的空操作。单位后缀只影响显示，不改变
    // 取值域，这里不编造上下限（`min`/`max` 留空 = 不比协议更严，与内核一致）。
    if let Some((unit, value)) = rest.split_once('=') {
        let unit = unit.trim();
        if matches!(unit, "px" | "mm" | "deg" | "%") {
            let mut spec = ParamSpec::new(key, ParamKind::Number);
            spec.default = value.trim().parse::<f64>().ok().map(|v| json!(v));
            return Some(spec);
        }
    }
    // 数字范围：`min..max=default`（也接受 `min-max=default` 这种历史写法）。
    let (range, default) = match rest.split_once('=') {
        Some((range, value)) => (range.trim(), value.trim()),
        None => (rest, ""),
    };
    let bounds = range
        .split_once("..")
        .map(|(a, b)| (a.trim().to_string(), b.trim().to_string()))
        .or_else(|| {
            let digits = range.trim_start_matches('-');
            let idx = digits.find('-')?;
            let split = if range.starts_with('-') { idx + 1 } else { idx };
            Some((range[..split].to_string(), range[split + 1..].to_string()))
        });
    if let Some((low, high)) = bounds
        && let (Ok(min), Ok(max)) = (low.parse::<f64>(), high.parse::<f64>())
    {
        let mut spec = ParamSpec::new(key, ParamKind::Number);
        spec.min = Some(min);
        spec.max = Some(max);
        spec.default = default.parse::<f64>().ok().map(|v| json!(v));
        return Some(spec);
    }
    // 其余（json / text / doc / int[25] / px / mm / %）是需要结构校验的资源参数。
    Some(ParamSpec::new(key, ParamKind::Resource))
}

/// 解析出的参数清单（未知命令为空）。
pub fn params(id: &str) -> Vec<ParamSpec> {
    if id == "filter.filterGallery" {
        // 效果栈由 gallery 模块持有，不把 `effects` 当普通参数。
        let mut out = Vec::new();
        for key in ["foreground", "background"] {
            let mut spec = ParamSpec::new(key, ParamKind::Color);
            spec.default = Some(Value::String("#000000".into()));
            out.push(spec);
        }
        return out;
    }
    let Some(spec) = photocraft_engine::commands::find(id) else { return Vec::new() };
    let text = spec.params.trim();
    // 记法可以带返回注解：`{"a":bool} → {layer,newLayer,…}`。返回字段不是入参，先切掉，
    // 否则它会被并进最后一个参数字段（火焰/画框/树因此把 `newLayer` 认成结构型资源）。
    let text = text.split('→').next().unwrap_or(text).trim();
    let Some(inner) = text.strip_prefix('{').and_then(|text| text.rsplit_once('}').map(|(head, _)| head)) else {
        return Vec::new();
    };
    let mut out: Vec<ParamSpec> = split_top(inner).iter().filter_map(|field| parse_field(field)).collect();
    out.truncate(MAX_PARAMS);
    out
}

/// 画廊滤镜的参数清单（来自画廊清单，同样不手写）。
pub fn gallery_params(key: &str) -> Option<Vec<ParamSpec>> {
    let filter = photocraft_algo::GalleryFilter::from_key(key)?;
    let mut out: Vec<ParamSpec> = split_top(filter.params_doc().trim().trim_start_matches('{').trim_end_matches('}'))
        .iter()
        .filter_map(|field| parse_field(field))
        .collect();
    out.truncate(MAX_PARAMS);
    Some(out)
}

fn finite(value: &Value) -> Option<f64> {
    value.as_f64().filter(|value| value.is_finite())
}

/// 校验一个已登记命令的参数；失败时返回可直接展示的中文原因。
///
/// 只校验本域清单里声明过的字段：`Resource` 字段交给几何/资源校验，未知字段不静默接受
/// （拼错参数名会让预览和确认结果都不符合用户预期）。
pub fn validate(id: &str, given: &Value) -> Result<()> {
    let entry = entry(id).ok_or_else(|| bad(format!("{id} 不是已开放的滤镜")))?;
    if !given.is_object() && !given.is_null() {
        return Err(bad("滤镜参数必须是 JSON 对象"));
    }
    let empty = Value::Object(Default::default());
    let given = if given.is_null() { &empty } else { given };
    let schema = params(id);
    for (key, value) in given.as_object().into_iter().flatten() {
        // 目标与资源字段由调用方单独校验；颜色参数只在上游确实读取颜色时才算声明过
        // （`filters_ext::prepare` 会写进 `foreground`/`background`，云彩、火焰等却只读
        // `Session::tools`，此时多带颜色必须报错而不是静默丢掉）。
        if matches!(key.as_str(), "layer" | "list" | "newLayer" | "effects")
            || (matches!(key.as_str(), "foreground" | "background") && uses_colours(id))
        {
            continue;
        }
        let spec = schema.iter().find(|spec| spec.key == *key);
        let Some(spec) = spec else {
            return Err(bad(format!("{} 没有参数 {key}", entry.label)));
        };
        match spec.kind {
            ParamKind::Number => {
                let value = finite(value)
                    .ok_or_else(|| bad(format!("{key} 必须是有限数值")))?;
                let (min, max) = (spec.min.unwrap_or(f64::MIN), spec.max.unwrap_or(f64::MAX));
                if value < min || value > max {
                    return Err(bad(format!("{key} 必须在 {min}–{max} 之间")));
                }
            }
            ParamKind::Integer => {
                let value = value
                    .as_u64()
                    .or_else(|| finite(value).filter(|v| *v >= 0.0 && v.fract() == 0.0).map(|v| v as u64))
                    .ok_or_else(|| bad(format!("{key} 必须是非负整数")))?;
                if let Some(max) = spec.max
                    && value as f64 > max
                {
                    return Err(bad(format!("{key} 超出范围")));
                }
            }
            ParamKind::Choice => {
                let name = value
                    .as_str()
                    .ok_or_else(|| bad(format!("{key} 必须是选项名")))?;
                if !spec.choices.iter().any(|choice| choice == name) {
                    return Err(bad(format!("{key} 必须是 {} 之一", spec.choices.join("/"))));
                }
            }
            ParamKind::Bool => {
                if !value.is_boolean() {
                    return Err(bad(format!("{key} 必须是布尔值")));
                }
            }
            ParamKind::Color => {
                let ok = match value {
                    Value::String(text) => {
                        text.len() == 7 && text.starts_with('#') && text[1..].chars().all(|c| c.is_ascii_hexdigit())
                    }
                    Value::Array(items) => {
                        (3..=4).contains(&items.len()) && items.iter().all(|item| finite(item).is_some())
                    }
                    _ => false,
                };
                if !ok {
                    return Err(bad(format!("{key} 必须是 #rrggbb 或 [r,g,b]")));
                }
            }
            ParamKind::Resource => {
                super::geometry::validate_resource(entry, key, value)?;
            }
        }
    }
    if entry.needs_map
        && given.get("mapDocument").is_none()
    {
        // 内核只接受 `mapPath`（本应用拒绝）或 `mapDocument`；单独给 `mapLayer` 等于没给来源，
        // 直接在这里说清楚，而不是让用户在预览时才看到内核的英文错误。
        let reason = if given.get("mapLayer").is_some() {
            "置换需要位移图文档：请选择来源文档，再用图层 id 指定该文档里的图层"
        } else {
            "置换滤镜需要位移图：请先选择位移图文档或其图层"
        };
        return Err(bad(reason));
    }
    if entry.kind == Kind::GalleryStack {
        super::gallery::validate_stack(given)?;
    }
    if entry.kind == Kind::BlurGallery {
        super::geometry::validate_blur_gallery(entry.id, given)?;
    }
    if entry.kind == Kind::VanishingPoint {
        super::geometry::validate_vanishing_point(given)?;
    }
    Ok(())
}

/// 默认参数（面板初始值；同时是「重复上次」缺失字段的回填来源）。
pub fn default_params(id: &str) -> Value {
    let mut out = serde_json::Map::new();
    for spec in params(id) {
        if let Some(default) = spec.default {
            out.insert(spec.key.clone(), default);
        }
    }
    Value::Object(out)
}

/// 面板/宿主使用的完整清单（含参数 schema 与画廊目录）。
pub fn catalogue() -> Value {
    let filters: Vec<Value> = ENTRIES
        .iter()
        .map(|entry| {
            json!({
                "id": entry.id,
                "label": entry.label,
                "category": entry.category,
                "kind": match entry.kind {
                    Kind::Simple => "simple",
                    Kind::Random => "random",
                    Kind::Gallery => "gallery",
                    Kind::GalleryStack => "galleryStack",
                    Kind::BlurGallery => "blurGallery",
                    Kind::Lens => "lens",
                    Kind::CameraRaw => "cameraRaw",
                    Kind::VanishingPoint => "vanishingPoint",
                },
                "usesColours": uses_colours(entry.id),
                "needsMap": entry.needs_map,
                "params": params(entry.id).iter().map(ParamSpec::to_json).collect::<Vec<_>>(),
            })
        })
        .collect();
    json!({
        "filters": filters,
        "gallery": super::gallery::catalogue(),
        "limits": {
            "maxEffects": MAX_EFFECTS,
            "maxPins": MAX_PINS,
            "maxPlanes": MAX_PLANES,
            "maxParams": MAX_PARAMS,
            "maxResourcePoints": MAX_RESOURCE_POINTS,
            "seedMax": u32::MAX,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_registered_command_exists_in_the_engine_registry() {
        for id in ids() {
            assert!(
                photocraft_engine::commands::find(id).is_some(),
                "清单里的命令在上游注册表中不存在：{id}"
            );
        }
        for (a, b) in ENTRIES.iter().zip(ENTRIES.iter().skip(1)) {
            assert_ne!(a.id, b.id, "清单重复登记 {}", a.id);
        }
    }

    #[test]
    fn excluded_commands_stay_out_of_the_catalogue() {
        for id in [
            "filter.liquify",
            "filter.convertForSmartFilters",
            "filter.gallery.liquify",
            "plugin.run",
            "filter.nope",
        ] {
            assert!(!contains(id), "{id} 不能进入已验收清单");
        }
    }

    #[test]
    fn param_notation_is_parsed_from_the_engine_registry() {
        let radius = params("filter.blur.gaussianBlur")
            .into_iter()
            .find(|spec| spec.key == "radius")
            .expect("radius");
        assert_eq!(radius.kind, ParamKind::Number);
        assert_eq!(radius.min, Some(0.1));
        assert_eq!(radius.max, Some(1000.0));
        assert_eq!(radius.default, Some(json!(1.0)));

        let quality = params("filter.blur.radialBlur")
            .into_iter()
            .find(|spec| spec.key == "quality")
            .expect("quality");
        assert_eq!(quality.kind, ParamKind::Choice);
        assert_eq!(quality.choices, vec!["draft", "good", "best"]);
        assert_eq!(quality.default, Some(json!("good")));

        let seed = params("filter.noise.addNoise")
            .into_iter()
            .find(|spec| spec.key == "seed")
            .expect("seed");
        assert_eq!(seed.kind, ParamKind::Integer);
        assert_eq!(seed.max, Some(f64::from(u32::MAX)));

        let mono = params("filter.noise.addNoise")
            .into_iter()
            .find(|spec| spec.key == "monochromatic")
            .expect("monochromatic");
        assert_eq!(mono.kind, ParamKind::Bool);

        let kernel = params("filter.other.custom")
            .into_iter()
            .find(|spec| spec.key == "kernel")
            .expect("kernel");
        assert_eq!(kernel.kind, ParamKind::Resource);
    }

    #[test]
    fn unit_typed_numbers_are_numbers_not_resources() {
        // `px=0` / `mm=0` 是带单位的普通数字。当成结构型参数会让面板跳过它，
        // 用户拿到的默认参数里干脆没有这个字段 —— 位移滤镜因此一上来就是空操作。
        let offset = params("filter.other.offset");
        for key in ["horizontal", "vertical"] {
            let spec = offset.iter().find(|spec| spec.key == key).unwrap_or_else(|| panic!("{key}"));
            assert_eq!(spec.kind, ParamKind::Number, "{key} 必须是数字");
            assert_eq!(spec.default, Some(json!(0.0)), "{key} 默认值来自记法");
        }
        assert_eq!(default_params("filter.other.offset")["horizontal"], json!(0.0));
        assert_eq!(default_params("filter.other.offset")["vertical"], json!(0.0));

        let focal = params("filter.lensCorrection")
            .into_iter()
            .find(|spec| spec.key == "focalLength")
            .expect("focalLength");
        assert_eq!(focal.kind, ParamKind::Number);

        let vanishing = params("filter.vanishingPoint")
            .into_iter()
            .find(|spec| spec.key == "focalLength")
            .expect("focalLength");
        assert_eq!(vanishing.kind, ParamKind::Number);
    }

    #[test]
    fn return_annotations_do_not_leak_into_the_param_list() {
        // 这三条命令的记法带 `→ {…}` 返回注解；它不属于入参，
        // 漏进来会把最后一个字段（`newLayer`）从布尔认成结构型资源。
        for id in ["filter.render.flame", "filter.render.pictureFrame", "filter.render.tree"] {
            let spec = params(id).into_iter().find(|spec| spec.key == "newLayer").unwrap_or_else(|| panic!("{id} newLayer"));
            assert_eq!(spec.kind, ParamKind::Bool, "{id} 的 newLayer 必须是布尔");
            assert_eq!(spec.default, Some(json!(false)));
            assert!(
                params(id).iter().all(|spec| !spec.key.contains(' ')),
                "{id} 的参数名不能带返回注解残留"
            );
        }
    }

    #[test]
    fn validation_matches_the_engine_contract() {
        assert!(validate("filter.blur.gaussianBlur", &json!({"radius": 0.05})).is_err());
        assert!(validate("filter.blur.gaussianBlur", &json!({"radius": 1000.5})).is_err());
        assert!(validate("filter.blur.gaussianBlur", &json!({"radius": 2})).is_ok());
        assert!(validate("filter.blur.radialBlur", &json!({"quality": "ultra"})).is_err());
        assert!(validate("filter.blur.radialBlur", &json!({"quality": "best"})).is_ok());
        assert!(validate("filter.noise.addNoise", &json!({"seed": json!(u64::from(u32::MAX) + 1)})).is_err());
        assert!(validate("filter.noise.addNoise", &json!({"monochromatic": 1})).is_err());
        assert!(validate("filter.other.colorToAlpha", &json!({"color": "white"})).is_err());
        assert!(validate("filter.other.colorToAlpha", &json!({"color": "#ffffff"})).is_ok());
        assert!(validate("filter.blur.gaussianBlur", &json!({"radiu": 2})).is_err());
        assert!(validate("filter.liquify", &json!({})).is_err());
    }

    #[test]
    fn defaults_come_from_the_engine_notation() {
        let defaults = default_params("filter.sharpen.unsharpMask");
        assert_eq!(defaults["amount"], json!(50.0));
        assert_eq!(defaults["radius"], json!(1.0));
        assert_eq!(defaults["threshold"], json!(0.0));
        assert_eq!(default_params("filter.blur.blur"), json!({}));
    }

    #[test]
    fn colour_snapshot_never_injects_an_undeclared_parameter() {
        // `FilterDraft::begin` 会在读取颜色的滤镜上写 `foreground`/`background`。
        // 若清单把它们标宽了（例如把只读 `Session::tools` 的云彩标成参数化颜色），
        // 预览就会被自己的校验拒绝 —— 这正是此测试要钉住的回归。
        for entry in ENTRIES {
            if entry.needs_map || matches!(entry.kind, Kind::BlurGallery | Kind::VanishingPoint | Kind::Lens | Kind::CameraRaw) {
                continue;
            }
            let mut params = default_params(entry.id);
            if uses_colours(entry.id) {
                let object = params.as_object_mut().expect("object");
                object.insert("foreground".into(), json!("#3366cc"));
                object.insert("background".into(), json!("#ffffff"));
            }
            if entry.kind == Kind::GalleryStack || entry.kind == Kind::Gallery {
                continue; // 画廊组合由画廊测试覆盖（需要 effects/默认组合）。
            }
            assert!(validate(entry.id, &params).is_ok(), "{} 的默认参数不能被自己的校验拒绝", entry.id);
        }
        // 上游只对这三条命令 + 画廊清单声明读取颜色。
        for id in ["filter.render.clouds", "filter.render.flame", "filter.render.tree", "filter.stylize.diffuse", "filter.other.colorToAlpha"] {
            assert!(!uses_colours(id), "{id} 不读取前景/背景色参数，不能打颜色标记");
        }
        for id in ["filter.render.fibers", "filter.stylize.tiles", "filter.pixelate.pointillize"] {
            assert!(uses_colours(id), "{id} 由上游写入颜色参数");
        }
        assert!(params("filter.render.fibers").iter().any(|spec| spec.key == "foreground"));
        assert!(!params("filter.render.clouds").iter().any(|spec| spec.key == "foreground"));
    }

    #[test]
    fn catalogue_is_bounded_and_has_unique_ids() {
        let catalogue = catalogue();
        let filters = catalogue["filters"].as_array().expect("filters");
        assert_eq!(filters.len(), ENTRIES.len());
        assert!(filters.len() < 160);
        let mut seen = std::collections::HashSet::new();
        for filter in filters {
            assert!(seen.insert(filter["id"].as_str().expect("id")));
            let params = filter["params"].as_array().expect("params");
            assert!(params.len() <= MAX_PARAMS);
        }
        assert_eq!(catalogue["limits"]["maxEffects"], json!(MAX_EFFECTS));
        assert_eq!(catalogue["limits"]["maxPins"], json!(MAX_PINS));
    }
}
