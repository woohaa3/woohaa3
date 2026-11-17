//! 片场透明度动作的材质实例（change: 2026-10-19-extend-film-set-for-motion-graphics，D2）。
//!
//! 规则（与 `bevy-model-runtime-components` 的透明度要求一致）：
//! - 透明度 1：恢复材质原 `alpha_mode`，静止画面不进入透明排序；
//! - 0 < 透明度 < 1：改用该实体的专属材质实例（克隆自共享材质），切 `AlphaMode::Blend`，
//!   并把 `base_color` alpha 设为「材质静态透明度 × 动作透明度」；
//! - 透明度 0：额外 `Visibility::Hidden`，不参与绘制与拾取。
//!
//! 实例状态在实体组件 [`OpacityMaterialInstance`] 上；本 Resource 只保留**实例回收策略**
//! （根释放时从材质资产中移除克隆实例），不再保存「实体 → 实例」的第二份 owner map
//! （change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs，5.3）。共享材质本身**不**被修改，
//! 因此同一材质的其它部件不受影响，静态合并块的 mesh/实体/合批计划也不变。

use std::collections::HashMap;

use bevy::prelude::*;

use crate::canvas_ecs::components::OpacityMaterialInstance;

/// 某模型根创建的透明度材质实例（回收策略；实体局部状态在组件上）。
#[derive(Default)]
pub(crate) struct OpacityMaterials {
    instances: Vec<Handle<StandardMaterial>>,
}

/// 一帧内某个实体应有的透明度（共享材质 + 组合后的动作透明度）。
pub(crate) type DesiredOpacity = HashMap<Entity, (Handle<StandardMaterial>, f32)>;

impl OpacityMaterials {
    /// 已创建的实例数（诊断与回归断言用：反复播放不得增长）。
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.instances.len()
    }

    /// 按本帧期望应用透明度：不在期望集合中的既有实例写回原材质。
    ///
    /// `existing` 是本帧从 ECS 组件派生的视图（`OpacityMaterialInstance`），不是所有者表。
    /// 只在透明度真正小于 1 的实体上建实例；共享材质缓存与静态合并块不受影响。
    pub(crate) fn sync_frame(
        &mut self,
        materials: &mut Assets<StandardMaterial>,
        commands: &mut Commands,
        existing: &HashMap<Entity, OpacityMaterialInstance>,
        desired: &DesiredOpacity,
    ) {
        for (entity, record) in existing {
            if !desired.contains_key(entity) {
                Self::restore(commands, *entity, record);
            }
        }
        for (entity, (original, opacity)) in desired {
            self.apply(materials, commands, existing, *entity, original, *opacity);
        }
    }

    fn apply(
        &mut self,
        materials: &mut Assets<StandardMaterial>,
        commands: &mut Commands,
        existing: &HashMap<Entity, OpacityMaterialInstance>,
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
        let mut record = existing.get(&entity).cloned().unwrap_or_else(|| {
            // 首次淡出：从当前共享材质克隆一份专属实例，并记住原状态。
            let source = materials.get(original).cloned().unwrap_or_default();
            let static_alpha = if source.alpha_mode == bevy::material::AlphaMode::Blend {
                source.base_color.alpha()
            } else {
                1.0
            };
            let mut instance = source.clone();
            instance.alpha_mode = bevy::material::AlphaMode::Blend;
            let instance = materials.add(instance);
            self.instances.push(instance.clone());
            OpacityMaterialInstance {
                instance,
                original: original.clone(),
                static_alpha,
                hidden: false,
            }
        });
        // 质量替换会更换共享材质句柄：恢复时必须写回当前表示，而不是首次克隆时的旧句柄。
        record.original = original.clone();
        let alpha = (record.static_alpha * opacity).clamp(0.0, 1.0);
        if let Some(mut material) = materials.get_mut(&record.instance) {
            material.base_color.set_alpha(alpha);
            material.alpha_mode = bevy::material::AlphaMode::Blend;
        }
        entity_commands.insert(MeshMaterial3d(record.instance.clone()));
        if opacity <= 0.0 && !record.hidden {
            entity_commands.insert(Visibility::Hidden);
            record.hidden = true;
        } else if opacity > 0.0 && record.hidden {
            entity_commands.insert(Visibility::Inherited);
            record.hidden = false;
        }
        entity_commands.insert(record);
    }

    /// 恢复某实体的原材质与可见性；实例句柄留给资源归属回收。
    fn restore(commands: &mut Commands, entity: Entity, record: &OpacityMaterialInstance) {
        let Ok(mut entity_commands) = commands.get_entity(entity) else {
            return;
        };
        entity_commands.insert(MeshMaterial3d(record.original.clone()));
        if record.hidden {
            entity_commands.insert(Visibility::Inherited);
        }
        let mut restored = record.clone();
        restored.hidden = false;
        entity_commands.insert(restored);
    }

    /// 恢复全部实体（对象根整体恢复或节点切换）。
    pub(crate) fn restore_all(
        &mut self,
        commands: &mut Commands,
        existing: &HashMap<Entity, OpacityMaterialInstance>,
    ) {
        for (entity, record) in existing {
            Self::restore(commands, *entity, record);
        }
    }

    /// Group binding replacement removes its entity subtree immediately. Entity-local
    /// opacity records are ECS components, so the next root release owns final handle cleanup;
    /// keeping the vector here avoids invalidating unchanged sibling components.
    pub(crate) fn remove_entities(
        &mut self,
        _materials: &mut Assets<StandardMaterial>,
        _entities: &[Entity],
    ) {
        // Components on despawned entities are gone; handles remain owned by this root until
        // `release_instances`, which prevents a sibling from observing a removed asset.
    }

    /// 根释放时丢弃全部实例并从材质资产中回收（D2 的生命周期归属）。
    ///
    /// 克隆实例不进入共享材质缓存，只能由这里显式移除；否则反复播放会积累无人引用的
    /// `StandardMaterial`。实体本身已随根销毁，无需再写回材质。
    pub(crate) fn release_instances(&mut self, materials: &mut Assets<StandardMaterial>) {
        for instance in self.instances.drain(..) {
            materials.remove(&instance);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(world: &mut World) -> HashMap<Entity, OpacityMaterialInstance> {
        let mut query = world.query::<(Entity, &OpacityMaterialInstance)>();
        query
            .iter(world)
            .map(|(entity, record)| (entity, record.clone()))
            .collect()
    }

    fn sync(
        world: &mut World,
        opacity: &mut OpacityMaterials,
        desired: &DesiredOpacity,
    ) {
        let existing = snapshot(world);
        world.resource_scope(|world, mut materials: Mut<Assets<StandardMaterial>>| {
            {
                let mut commands = world.commands();
                opacity.sync_frame(&mut materials, &mut commands, &existing, desired);
            }
            world.flush();
        });
    }

    /// 质量替换只换共享材质句柄：实体复用同一实例，恢复写回新句柄，根释放只回收一次。
    #[test]
    fn instance_survives_quality_replacement_without_leaking_materials() {
        let mut world = World::new();
        world.init_resource::<Assets<StandardMaterial>>();
        let (first, second) = {
            let mut materials = world.resource_mut::<Assets<StandardMaterial>>();
            (
                materials.add(StandardMaterial::default()),
                materials.add(StandardMaterial::default()),
            )
        };
        let entity = world.spawn(MeshMaterial3d(first.clone())).id();
        let mut opacity = OpacityMaterials::default();

        let mut desired = DesiredOpacity::new();
        desired.insert(entity, (first.clone(), 0.5));
        sync(&mut world, &mut opacity, &desired);

        let record = world
            .get::<OpacityMaterialInstance>(entity)
            .expect("淡出时写入实例组件")
            .clone();
        assert_ne!(record.instance, first);
        assert_eq!(record.original, first);
        assert_eq!(opacity.len(), 1);

        // 质量档位替换共享材质：透明度继续生效，但恢复目标改成当前共享句柄。
        desired.insert(entity, (second.clone(), 0.5));
        sync(&mut world, &mut opacity, &desired);
        let record_after = world
            .get::<OpacityMaterialInstance>(entity)
            .expect("变化档位后仍保留实例");
        assert_eq!(record_after.instance, record.instance, "同一实体复用实例");
        assert_eq!(record_after.original, second, "恢复目标跟随质量替换");
        assert_eq!(opacity.len(), 1, "质量替换不得再克隆实例");

        // 透明度回到 1：写回新共享材质，组件只清隐藏标记。
        sync(&mut world, &mut opacity, &DesiredOpacity::new());
        assert_eq!(
            world
                .get::<MeshMaterial3d<StandardMaterial>>(entity)
                .expect("restored")
                .0,
            second
        );
        assert!(
            !world
                .get::<OpacityMaterialInstance>(entity)
                .expect("component kept for reuse")
                .hidden
        );

        // 根释放：实例资产只被移除一次，两个共享材质保持。
        world.resource_scope(|_, mut materials: Mut<Assets<StandardMaterial>>| {
            opacity.release_instances(&mut materials);
            assert_eq!(materials.len(), 2, "实例回收后不应残留克隆材质");
        });
        assert_eq!(opacity.len(), 0);
    }
}
