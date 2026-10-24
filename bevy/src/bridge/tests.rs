mod tests {
    use crate::bridge::*;
    use crate::protocol::ModelAssetDescriptor;

    fn scene_with_revision(revision: u32) -> Scene {
        Scene {
            revision,
            ..Scene::default()
        }
    }

    #[test]
    fn scene_is_latest_wins() {
        queue_scene(scene_with_revision(1));
        queue_scene(scene_with_revision(2));
        let input = take_input();
        assert_eq!(input.scene.map(|scene| scene.revision), Some(2));
        assert!(take_input().scene.is_none());
    }

    #[test]
    fn textures_merge_per_key_and_drain() {
        queue_texture("a", 1, 1, &[1, 2, 3, 4]);
        queue_texture("b", 1, 1, &[5, 6, 7, 8]);
        queue_texture("a", 1, 1, &[9, 10, 11, 12]);
        let input = take_input();
        assert_eq!(input.textures.len(), 2);
        assert_eq!(input.textures["a"].2, vec![9, 10, 11, 12]);
        assert!(take_input().textures.is_empty());
    }

    #[test]
    fn ready_and_revision_round_trip() {
        set_ready(true);
        assert!(ready());
        set_revision(7);
        assert_eq!(revision(), 7);
    }

    fn descriptor(key: &str, signature: &str, radius: f32) -> ModelAssetDescriptor {
        ModelAssetDescriptor {
            resource_version: crate::protocol::MODEL_ASSET_VERSION.to_owned(),
            resource_key: key.to_owned(),
            scene_version: Some(crate::protocol::MODEL_SCENE_IR_V2.to_owned()),
            signature: signature.to_owned(),
            extent: 2.0,
            aabb: None,
            ops: vec![crate::protocol::ModelOp::Sphere {
                id: "s".into(),
                parent: None,
                position: [0.0; 3],
                rotation: [0.0; 3],
                scale: [1.0; 3],
                color: Some("#ffffff".into()),
                material: None,
                radius,
            }],
        }
    }

    #[test]
    fn model_asset_registration_is_idempotent_and_conflict_aware() {
        clear_model_assets();
        assert_eq!(
            queue_model_asset(descriptor("v2:abc", "abc", 1.0)),
            AssetRegistration::Ok
        );
        // 同 key 同内容：幂等成功。
        assert_eq!(
            queue_model_asset(descriptor("v2:abc", "abc", 1.0)),
            AssetRegistration::Ok
        );
        // 同 key 不同内容：冲突，且保留旧资源。
        assert_eq!(
            queue_model_asset(descriptor("v2:abc", "changed-content", 2.0)),
            AssetRegistration::Conflict
        );
        assert!(model_asset_registered("v2:abc"));
        clear_model_assets();
    }

    #[test]
    fn missing_model_asset_reports_referenced_key() {
        clear_model_assets();
        let reference = crate::protocol::ModelReference {
            scene_version: Some(crate::protocol::MODEL_SCENE_IR_V2.to_owned()),
            resource_key: "v2:missing".to_owned(),
            signature: "missing".to_owned(),
            placement: Default::default(),
        };
        let scene = Scene {
            nodes: vec![crate::protocol::GraphNode {
                model_preview: None,
                composite_asset: None,
                history_strip: None,
                aggregate_run: None,
                shot_preview: None,

                id: "n".into(),
                kind: "model".into(),
                x: 0.0,
                y: 0.0,
                width: 224.0,
                height: 116.0,
                body: String::new(),
            title: String::new(),
            type_label: String::new(),
                progress: 0.0,
                busy: false,
                texture: false,
                media_loading: false,
                resizable: false,
                ghost: false,
            card_label: None,
                group: None,
                model: Some(reference),
            }],
            ..Scene::default()
        };
        assert_eq!(missing_model_asset(&scene).as_deref(), Some("v2:missing"));
        queue_model_asset(descriptor("v2:missing", "missing", 1.0));
        assert!(missing_model_asset(&scene).is_none());
        clear_model_assets();
    }

    #[test]
    fn first_scene_can_register_more_models_than_the_idle_cache_budget() {
        clear_model_assets();
        let count = MODEL_ASSET_MAX_ENTRIES + 4;
        let mut nodes = Vec::new();
        for index in 0..count {
            let signature = format!("first-{index}");
            let key = format!("v2:{signature}");
            queue_model_asset(descriptor(&key, &signature, 1.0));
            let mut node: crate::protocol::GraphNode = serde_json::from_value(serde_json::json!({
                "id": format!("object-{index}"), "type": "model",
                "x": index as f32 * 260.0, "y": 0.0, "width": 248.0, "height": 232.0,
                "model": { "resourceKey": key, "signature": signature }
            })).unwrap();
            // Object containers and ordinary model cards share the same immutable resource table.
            if index >= 22 {
                node.composite_asset = Some(serde_json::from_value(serde_json::json!({
                    "x": 0.0, "y": 0.0, "width": 248.0, "height": 232.0
                })).unwrap());
            }
            nodes.push(node);
        }
        let scene = Scene { nodes, ..Scene::default() };
        assert!(missing_model_asset(&scene).is_none(), "first-frame registration must not evict models before scene acceptance");
        queue_scene(scene.clone());
        assert_eq!(model_assets_snapshot().len(), count, "the cache budget applies to idle resources, not live scene models");
        assert!(missing_model_asset(&scene).is_none());

        let mut next = scene.clone();
        next.nodes.truncate(1);
        queue_scene(next.clone());
        assert!(missing_model_asset(&next).is_none());
        assert_eq!(model_assets_snapshot().len(), MODEL_ASSET_MAX_ENTRIES, "unused resources are reclaimed after accepting the next scene");
        clear_model_assets();
    }

    #[test]
    fn asset_eviction_keeps_scene_referenced_entries() {
        clear_model_assets();
        let protected = "v2:keep";
        queue_model_asset(descriptor(protected, "keep", 1.0));
        // 排队一个引用 protected 的场景。
        queue_scene(Scene {
            nodes: vec![crate::protocol::GraphNode {
                model_preview: None,
                composite_asset: None,
                history_strip: None,
                aggregate_run: None,
                shot_preview: None,

                id: "n".into(),
                kind: "model".into(),
                x: 0.0,
                y: 0.0,
                width: 224.0,
                height: 116.0,
                body: String::new(),
            title: String::new(),
            type_label: String::new(),
                progress: 0.0,
                busy: false,
                texture: false,
                media_loading: false,
                resizable: false,
                ghost: false,
            card_label: None,
                group: None,
                model: Some(crate::protocol::ModelReference {
                    scene_version: Some(crate::protocol::MODEL_SCENE_IR_V2.to_owned()),
                    resource_key: protected.to_owned(),
                    signature: "keep".to_owned(),
                    placement: Default::default(),
                }),
            }],
            ..Scene::default()
        });
        for index in 0..(MODEL_ASSET_MAX_ENTRIES + 4) {
            let key = format!("v2:extra-{index}");
            queue_model_asset(descriptor(&key, &format!("sig-{index}"), 1.0));
        }
        assert!(
            model_asset_registered(protected),
            "最近场景引用的资源不得被淘汰"
        );
        queue_scene(Scene::default());
        clear_model_assets();
    }
}
