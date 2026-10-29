//! material key 规范化与受控 PBR 构建
//! （change: refactor-bevy-rust-file-size，任务 2.2 / design D2）。

use bevy::prelude::*;

use crate::protocol::{ModelOp, ModelSnapshot};

/// material 规范化 key：`color` 简写与 `material` 引用都不会与 transform 混淆。
pub(crate) fn material_key(op: &ModelOp) -> String {
    match op {
        ModelOp::Material { id, .. } => format!("material:{id}"),
        ModelOp::Box {
            color, material, ..
        }
        | ModelOp::Cylinder {
            color, material, ..
        }
        | ModelOp::Mesh {
            color, material, ..
        }
        | ModelOp::Sphere {
            color, material, ..
        }
        | ModelOp::Capsule {
            color, material, ..
        }
        | ModelOp::Segment {
            color, material, ..
        } => match material {
            Some(id) => format!("material:{id}"),
            None => format!(
                "color:{}",
                normalize_hex(color.as_deref().unwrap_or("#cccccc"))
            ),
        },
        _ => String::new(),
    }
}

/// `#rgb`/`#rrggbb` 小写规范化（与 contracts `normalizeHex` 一致）。
pub(crate) fn normalize_hex(value: &str) -> String {
    let source = value
        .strip_prefix('#')
        .unwrap_or(value)
        .to_ascii_lowercase();
    let expanded = if source.len() == 3 {
        source.chars().flat_map(|ch| [ch, ch]).collect::<String>()
    } else {
        source
    };
    format!("#{expanded}")
}

/// material key → 受控 `StandardMaterial`（PBR 子集）。
pub(crate) fn standard_material_for(
    key: &str,
    materials: &std::collections::HashMap<String, MaterialSpec>,
) -> StandardMaterial {
    if let Some(spec) = key.strip_prefix("material:")
        && let Some(spec) = materials.get(spec)
    {
        return spec.to_material();
    }
    if let Some(color) = key.strip_prefix("color:") {
        return StandardMaterial {
            base_color: parse_hex(color),
            perceptual_roughness: 0.85,
            cull_mode: None,
            ..default()
        };
    }
    StandardMaterial::default()
}

/// 受控 PBR 子集（来自 V2 `material` op）。
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct MaterialSpec {
    pub(crate) base_color: [f32; 4],
    pub(crate) roughness: f32,
    pub(crate) metallic: f32,
    pub(crate) emissive: [f32; 4],
    pub(crate) alpha_mode: String,
    pub(crate) double_sided: bool,
    /// 不受光照（平面色）；参与 `StandardMaterial::unlit` 与材质缓存键。
    pub(crate) unlit: bool,
    /// blend 模式的静态透明度；opaque 下恒为 1（不参与呈现）。
    pub(crate) opacity: f32,
}

impl MaterialSpec {
    pub(crate) fn from_op(op: &ModelOp) -> Option<(String, Self)> {
        match op {
            ModelOp::Material {
                id,
                base_color,
                roughness,
                metallic,
                emissive,
                emissive_strength,
                alpha_mode,
                double_sided,
                unlit,
                opacity,
            } => {
                let base = parse_hex(base_color).to_srgba();
                let em = parse_hex(emissive).to_srgba();
                let strength = emissive_strength.max(0.0);
                let blend = alpha_mode == "blend";
                Some((
                    id.clone(),
                    Self {
                        base_color: [base.red, base.green, base.blue, base.alpha],
                        roughness: *roughness,
                        metallic: *metallic,
                        emissive: [
                            em.red * strength,
                            em.green * strength,
                            em.blue * strength,
                            1.0,
                        ],
                        alpha_mode: alpha_mode.clone(),
                        double_sided: *double_sided,
                        unlit: *unlit,
                        opacity: if blend {
                            opacity
                                .filter(|value| value.is_finite())
                                .map(|value| value.clamp(0.0, 1.0))
                                .unwrap_or(crate::protocol::DEFAULT_BLEND_OPACITY)
                        } else {
                            1.0
                        },
                    },
                ))
            }
            _ => None,
        }
    }

    pub(crate) fn to_material(&self) -> StandardMaterial {
        let mut material = StandardMaterial {
            base_color: Color::srgb(self.base_color[0], self.base_color[1], self.base_color[2]),
            perceptual_roughness: self.roughness.clamp(0.0, 1.0),
            metallic: self.metallic.clamp(0.0, 1.0),
            emissive: LinearRgba::new(
                self.emissive[0],
                self.emissive[1],
                self.emissive[2],
                self.emissive[3],
            ),
            unlit: self.unlit,
            cull_mode: if self.double_sided {
                None
            } else {
                Some(bevy::render::render_resource::Face::Back)
            },
            ..default()
        };
        if self.alpha_mode == "blend" {
            // 首版只提供基础 blend；不承诺复杂多层透明正确排序。
            material.base_color.set_alpha(self.opacity.clamp(0.0, 1.0));
            material.alpha_mode = bevy::material::AlphaMode::Blend;
        }
        material
    }

    /// 该材质的**静态**透明度（opaque 为 1）；供模型透明度动作与材质相乘。
    #[allow(dead_code)]
    pub(crate) fn static_opacity(&self) -> f32 {
        if self.alpha_mode == "blend" {
            self.opacity.clamp(0.0, 1.0)
        } else {
            1.0
        }
    }
}

/// 解析 `#rgb` / `#rrggbb`（可省略 `#`），非法值回退中性灰。
pub(crate) fn parse_hex(value: &str) -> Color {
    let source = normalize_hex(value);
    let hex = source.strip_prefix('#').unwrap_or(&source);
    if hex.len() != 6 {
        return Color::srgb_u8(204, 204, 204);
    }
    u32::from_str_radix(hex, 16)
        .map(|value| Color::srgb_u8((value >> 16) as u8, (value >> 8) as u8, value as u8))
        .unwrap_or_else(|_| Color::srgb_u8(204, 204, 204))
}

/// 收集 scene 内所有 material 声明。
pub(crate) fn collect_materials(
    model: &ModelSnapshot,
) -> std::collections::HashMap<String, MaterialSpec> {
    model.ops.iter().filter_map(MaterialSpec::from_op).collect()
}
