//! Immutable per-part bounds. Runtime placement queries never copy or scan mesh arrays.
use super::{ModelAabb, ModelEntitySpec, aabb::geometry_half_extents_and_center};
use crate::protocol::{ModelPlacement, ModelSnapshot};
use bevy::prelude::*;
use std::{
    borrow::Cow,
    collections::{HashMap, HashSet},
};

#[derive(Clone, Debug)]
struct Part {
    id: String,
    parent: Option<String>,
    local: Transform,
    geometry: Option<ModelAabb>,
}

#[derive(Debug)]
pub(crate) struct PreparedBounds {
    parts: Vec<Part>,
    pub(crate) local: Option<ModelAabb>,
}

impl PreparedBounds {
    pub(super) fn new(specs: &[ModelEntitySpec]) -> Self {
        let parts: Vec<_> = specs
            .iter()
            .map(|spec| {
                let geometry = spec.geometry.as_ref().map(|geometry| {
                    let (half, center) = geometry_half_extents_and_center(geometry);
                    ModelAabb::new(
                        std::array::from_fn(|axis| center[axis] - half[axis]),
                        std::array::from_fn(|axis| center[axis] + half[axis]),
                    )
                });
                Part {
                    id: spec.id.clone(),
                    parent: spec.parent.clone(),
                    local: Transform {
                        translation: Vec3::from_array(spec.position),
                        rotation: super::types::quat_from_xyz_radians(spec.rotation_radians),
                        scale: Vec3::from_array(spec.scale),
                    },
                    geometry,
                }
            })
            .collect();
        let local = evaluate(&parts, Placements::None)
            .into_iter()
            .map(|(_, bounds)| bounds)
            .reduce(ModelAabb::union);
        Self { parts, local }
    }

    pub(crate) fn for_model(model: &ModelSnapshot) -> std::sync::Arc<Self> {
        model
            .prepared_bounds
            .clone()
            .unwrap_or_else(|| std::sync::Arc::new(Self::new(&super::build_entity_specs(model))))
    }

    pub(crate) fn placed_local(&self, bases: &HashMap<String, Transform>) -> Option<ModelAabb> {
        if bases.is_empty() {
            return self.local;
        }
        evaluate(&self.parts, Placements::Bases(bases))
            .into_iter()
            .map(|(_, bounds)| bounds)
            .reduce(ModelAabb::union)
    }

    pub(crate) fn bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.parts.capacity() * std::mem::size_of::<Part>()
            + self
                .parts
                .iter()
                .map(|part| part.id.capacity() + part.parent.as_ref().map_or(0, String::capacity))
                .sum::<usize>()
    }
}

fn parts(model: &ModelSnapshot) -> Cow<'_, [Part]> {
    match &model.prepared_bounds {
        Some(bounds) => Cow::Borrowed(&bounds.parts),
        None => Cow::Owned(PreparedBounds::new(&super::build_entity_specs(model)).parts),
    }
}

fn evaluate<'a>(parts: &'a [Part], placement: Placements<'_>) -> Vec<(&'a str, ModelAabb)> {
    let mut worlds = HashMap::<&str, Transform>::with_capacity(parts.len());
    let mut bounds = Vec::new();
    for part in parts {
        // The original placement adapter only overrides group operations.
        let local = placement
            .get(&part.id)
            .filter(|_| part.geometry.is_none())
            .unwrap_or(part.local);
        let world = part
            .parent
            .as_deref()
            .and_then(|id| worlds.get(id))
            .map_or(local, |parent| parent.mul_transform(local));
        worlds.insert(&part.id, world);
        if let Some(geometry) = part.geometry {
            bounds.push((part.id.as_str(), geometry.transformed(&world)));
        }
    }
    bounds
}

enum Placements<'a> {
    None,
    Protocol(Option<&'a HashMap<String, ModelPlacement>>),
    Bases(&'a HashMap<String, Transform>),
}
impl Placements<'_> {
    fn get(&self, id: &str) -> Option<Transform> {
        match self {
            Self::None => None,
            Self::Bases(bases) => bases.get(id).copied(),
            Self::Protocol(placements) => {
                let placement = placements.as_ref()?.get(id)?;
                Some(Transform {
                    translation: Vec3::new(
                        placement.offset.x,
                        placement.offset.y,
                        placement.offset.z,
                    ),
                    rotation: Quat::from_rotation_y(placement.yaw.to_radians()),
                    scale: Vec3::splat(placement.scale),
                })
            }
        }
    }
}

pub(crate) fn placed_local_aabb(
    model: &ModelSnapshot,
    placements: Option<&HashMap<String, ModelPlacement>>,
) -> Option<ModelAabb> {
    if placements.is_none_or(HashMap::is_empty) {
        if let Some(bounds) = &model.prepared_bounds {
            return bounds.local;
        }
    }
    evaluate(&parts(model), Placements::Protocol(placements))
        .into_iter()
        .map(|(_, bounds)| bounds)
        .reduce(ModelAabb::union)
}

pub(crate) fn placed_subtree_aabbs(
    model: &ModelSnapshot,
    roots: &[String],
    placements: Option<&HashMap<String, ModelPlacement>>,
) -> Vec<(String, ModelAabb)> {
    placed_subtree_aabbs_counted(model, roots, placements).0
}

/// Same derivation as [`placed_subtree_aabbs`], additionally reporting how many part bounds the
/// evaluation actually visited (`evaluate` output length).
///
/// change: 2026-10-14-scope-film-set-object-picking-to-focus，任务 3.1 —— 只供内部对象候选的
/// 诊断边界消费；计数取自真实求值结果，不额外遍历、不引入第二次 `evaluate`。
pub(crate) fn placed_subtree_aabbs_counted(
    model: &ModelSnapshot,
    roots: &[String],
    placements: Option<&HashMap<String, ModelPlacement>>,
) -> (Vec<(String, ModelAabb)>, usize) {
    let parts = parts(model);
    let roots: HashSet<_> = roots.iter().map(String::as_str).collect();
    let parents: HashMap<_, _> = parts
        .iter()
        .map(|part| (part.id.as_str(), part.parent.as_deref()))
        .collect();
    let mut owners = HashMap::<&str, Option<&str>>::new();
    for part in parts.iter() {
        let mut cursor = Some(part.id.as_str());
        let mut chain = Vec::new();
        let owner = loop {
            let Some(id) = cursor else {
                break None;
            };
            if roots.contains(id) {
                break Some(id);
            }
            if let Some(owner) = owners.get(id) {
                break *owner;
            }
            // Valid prepared hierarchies are acyclic; raw native/test inputs stay bounded.
            if chain.len() >= parts.len() {
                break None;
            }
            chain.push(id);
            cursor = parents.get(id).copied().flatten();
        };
        owners.insert(part.id.as_str(), owner);
        for id in chain {
            owners.insert(id, owner);
        }
    }
    let mut result = HashMap::<String, ModelAabb>::new();
    // 计数只在真实求值结果上累加：无几何根不会制造“额外求值”，清空目标不进入本函数。
    let evaluated = evaluate(&parts, Placements::Protocol(placements));
    let evaluated_parts = evaluated.len();
    for (id, bounds) in evaluated {
        let Some(Some(owner)) = owners.get(id) else {
            continue;
        };
        result
            .entry((*owner).to_owned())
            .and_modify(|value| *value = value.union(bounds))
            .or_insert(bounds);
    }
    (result.into_iter().collect(), evaluated_parts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepared_bounds_preserve_nested_custom_geometry_and_dynamic_group_placement() {
        let raw: ModelSnapshot = serde_json::from_value(serde_json::json!({
            "sceneVersion":"woohaa-model-scene-ir-v2", "signature":"bounds", "extent":2,
            "ops":[
                {"t":"group","id":"outer","position":[1,2,3],"rotation":[0,30,0],"scale":[2,1,3]},
                {"t":"group","id":"inner","parent":"outer","position":[2,0,1],"rotation":[20,0,10],"scale":[1,2,1]},
                {"t":"mesh","id":"mesh","parent":"inner","vertices":[[-1,0,0],[2,1,0],[0,0,3]],"faces":[[0,1,2]]},
                {"t":"box","id":"box","parent":"outer","size":[1,2,3]}
            ]
        })).unwrap();
        let node: crate::protocol::GraphNode = serde_json::from_value(serde_json::json!({
            "id":"film","type":"model","x":0,"y":0,"width":120,"height":100,
            "compositeAsset":{"x":0,"y":0,"width":120,"height":100,"itemPlacements":{
                "outer":{"offset":{"x":4,"y":2,"z":-3},"scale":2,"yaw":31},
                "inner":{"offset":{"x":-2,"y":0,"z":1},"scale":0.5,"yaw":-20}
            }}
        }))
        .unwrap();
        let expected = crate::model3d::item_placement::snapshot(&raw, &node);
        let prepared = super::super::prepare_snapshot(raw.clone());
        let placements = &node.composite_asset.as_ref().unwrap().item_placements;
        let actual = placed_local_aabb(&prepared, Some(placements)).unwrap();
        let expected_local = super::super::model_local_aabb(&expected).unwrap();
        assert!(
            Vec3::from_array(actual.min).abs_diff_eq(Vec3::from_array(expected_local.min), 1e-4)
        );
        assert!(
            Vec3::from_array(actual.max).abs_diff_eq(Vec3::from_array(expected_local.max), 1e-4)
        );
        assert_eq!(
            super::super::model_local_aabb(&raw),
            super::super::model_local_aabb(&prepared)
        );
        let roots = vec!["outer".into(), "inner".into()];
        let actual: HashMap<_, _> = placed_subtree_aabbs(&prepared, &roots, Some(placements))
            .into_iter()
            .collect();
        let expected: HashMap<_, _> = super::super::model_subtree_aabb_by_root(&expected, &roots)
            .into_iter()
            .collect();
        assert_eq!(actual.len(), 2);
        for root in &roots {
            assert!(
                Vec3::from_array(actual[root].min)
                    .abs_diff_eq(Vec3::from_array(expected[root].min), 1e-4)
            );
            assert!(
                Vec3::from_array(actual[root].max)
                    .abs_diff_eq(Vec3::from_array(expected[root].max), 1e-4)
            );
        }
        assert!(prepared.prepared_bounds.as_ref().unwrap().bytes() > 0);
        let copy = prepared.clone();
        assert!(std::sync::Arc::ptr_eq(
            prepared.prepared_bounds.as_ref().unwrap(),
            copy.prepared_bounds.as_ref().unwrap()
        ));
    }
}
