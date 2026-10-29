//! 片场透明度动作的材质实例（change: 2026-10-19-extend-film-set-for-motion-graphics，D2）。
//!
//! 规则（与 `bevy-model-runtime-components` 的透明度要求一致）：
//! - 透明度 1：恢复材质原 `alpha_mode`，静止画面不进入透明排序；
//! - 0 < 透明度 < 1：改用该实体的专属材质实例（克隆自共享材质），切 `AlphaMode::Blend`，
//!   并把 `base_color` alpha 设为「材质静态透明度 × 动作透明度」；
//! - 透明度 0：额外 `Visibility::Hidden`，不参与绘制与拾取。
//!
//! 实例按实体记录并复用；实体或轨道消失时写回原材质。共享材质本身**不**被修改，因此同一
//! 材质的其它部件不受影响，静态合并块的 mesh/实体/合批计划也不变。

use std::collections::HashMap;

use bevy::prelude::*;

/// 一个实体的透明度材质实例。
struct OpacityMaterial {
    /// 克隆出来的专属实例。
    instance: Handle<StandardMaterial>,
    /// 原共享材质（透明度回到 1 时写回）。
    original: Handle<StandardMaterial>,
    /// 原材质自身的静态透明度（blend 材质取它的 alpha，opaque 为 1）。
    static_alpha: f32,
    /// 当前是否因透明度 0 而隐藏。
    hidden: bool,
}

/// 某模型根持有的透明度材质实例表（实体 → 实例）。
#[derive(Default)]
pub(crate) struct OpacityMaterials {
    entries: HashMap<Entity, OpacityMaterial>,
}

/// 一帧内某个实体应有的透明度（共享材质 + 组合后的动作透明度）。
pub(crate) type DesiredOpacity = HashMap<Entity, (Handle<StandardMaterial>, f32)>;

impl OpacityMaterials {
    /// 已创建的实例数（诊断与回归断言用：反复播放不得增长）。
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    /// 按本帧期望应用透明度：不在期望集合中的既有实例写回原材质。
    ///
    /// 只在透明度真正小于 1 的实体上建实例；共享材质缓存与静态合并块不受影响。
    pub(crate) fn sync_frame(
        &mut self,
        materials: &mut Assets<StandardMaterial>,
        commands: &mut Commands,
        desired: &DesiredOpacity,
    ) {
        let stale: Vec<Entity> = self
            .entries
            .keys()
            .filter(|entity| !desired.contains_key(entity))
            .copied()
            .collect();
        for entity in stale {
            self.restore(commands, entity);
        }
        for (entity, (original, opacity)) in desired {
            self.apply(materials, commands, *entity, original, *opacity);
        }
    }

    fn apply(
        &mut self,
        materials: &mut Assets<StandardMaterial>,
        commands: &mut Commands,
        entity: Entity,
        original: &Handle<StandardMaterial>,
        opacity: f32,
    ) {
        let opacity = if opacity.is_finite() {
            opacity.clamp(0.0, 1.0)
        } else {
            1.0
        };
        let Ok(mut entity_commands) = commands.get_entity(entity) else {
            return;
        };
        let record = self.entries.entry(entity).or_insert_with(|| {
            // 首次淡出：从当前共享材质克隆一份专属实例，并记住原状态。
            let source = materials.get(original).cloned().unwrap_or_default();
            let static_alpha = if source.alpha_mode == bevy::material::AlphaMode::Blend {
                source.base_color.alpha()
            } else {
                1.0
            };
            let mut instance = source.clone();
            instance.alpha_mode = bevy::material::AlphaMode::Blend;
            OpacityMaterial {
                instance: materials.add(instance),
                original: original.clone(),
                static_alpha,
                hidden: false,
            }
        });
        let alpha = (record.static_alpha * opacity).clamp(0.0, 1.0);
        if let Some(mut material) = materials.get_mut(&record.instance) {
            material.base_color.set_alpha(alpha);
            material.alpha_mode = bevy::material::AlphaMode::Blend;
        }
        let instance = record.instance.clone();
        entity_commands.insert(MeshMaterial3d(instance));
        if opacity <= 0.0 && !record.hidden {
            entity_commands.insert(Visibility::Hidden);
            record.hidden = true;
        } else if opacity > 0.0 && record.hidden {
            entity_commands.insert(Visibility::Inherited);
            record.hidden = false;
        }
    }

    /// 恢复某实体的原材质与可见性；实例句柄留给资源归属回收。
    pub(crate) fn restore(&mut self, commands: &mut Commands, entity: Entity) {
        let Some(record) = self.entries.get_mut(&entity) else {
            return;
        };
        if let Ok(mut entity_commands) = commands.get_entity(entity) {
            entity_commands.insert(MeshMaterial3d(record.original.clone()));
            if record.hidden {
                entity_commands.insert(Visibility::Inherited);
            }
        }
        record.hidden = false;
    }

    /// 恢复全部实体（对象根整体恢复或节点切换）。
    pub(crate) fn restore_all(&mut self, commands: &mut Commands) {
        for entity in self.entries.keys().copied().collect::<Vec<_>>() {
            self.restore(commands, entity);
        }
    }

    /// Reclaim only removed binding entities; unchanged objects keep their material instances.
    pub(crate) fn remove_entities(
        &mut self,
        materials: &mut Assets<StandardMaterial>,
        entities: &[Entity],
    ) {
        for entity in entities {
            if let Some(record) = self.entries.remove(entity) {
                materials.remove(&record.instance);
            }
        }
    }

    /// 根释放时丢弃全部实例并从材质资产中回收（D2 的生命周期归属）。
    ///
    /// 克隆实例不进入共享材质缓存，只能由这里显式移除；否则反复播放会积累无人引用的
    /// `StandardMaterial`。实体本身已随根销毁，无需再写回材质。
    pub(crate) fn release_instances(&mut self, materials: &mut Assets<StandardMaterial>) {
        for (_, record) in self.entries.drain() {
            materials.remove(&record.instance);
        }
    }

    /// 丢弃已销毁实体的记录（资源由根释放路径回收）。
    #[allow(dead_code)]
    pub(crate) fn retain_existing(&mut self, commands: &mut Commands) {
        let stale: Vec<Entity> = self
            .entries
            .keys()
            .filter(|entity| commands.get_entity(**entity).is_err())
            .copied()
            .collect();
        for entity in stale {
            self.entries.remove(&entity);
        }
    }
}

/// 材质的静态透明度（供调用方与动作透明度相乘；opaque 为 1）。
#[allow(dead_code)]
pub(crate) fn material_static_alpha(material: &StandardMaterial) -> f32 {
    if material.alpha_mode == bevy::material::AlphaMode::Blend {
        material.base_color.alpha()
    } else {
        1.0
    }
}
