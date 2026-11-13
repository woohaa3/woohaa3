mod tests {
    use crate::bridge::*;
    use crate::protocol::{ModelAssetDescriptor, ModelDescriptor, ModelDescriptorDto, Scene};

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
        queue_texture("a", 1, 1, &[1, 2, 3, 4], Some("content"));
        queue_texture("b", 1, 1, &[5, 6, 7, 8], None);
        queue_texture("a", 1, 1, &[9, 10, 11, 12], Some("content"));
        let input = take_input();
        assert_eq!(input.textures.len(), 2);
        assert_eq!(input.textures["a"].2, vec![9, 10, 11, 12]);
        assert_eq!(input.textures["a"].3.as_deref(), Some("content"));
        assert_eq!(input.textures["b"].3, None);
        assert!(take_input().textures.is_empty());
    }

    #[test]
    fn borrowed_uploads_keep_independent_pixels_after_caller_reuses_its_buffer() {
        let _ = take_input();
        let mut pixels = vec![1, 2, 3, 4];
        queue_texture("image", 1, 1, &pixels, Some("asset"));
        queue_model_texture("plane", 1, 1, &pixels);
        pixels.fill(0);
        let input = take_input();
        assert_eq!(input.textures["image"].2, vec![1, 2, 3, 4]);
        assert_eq!(input.model_textures["plane"].2, vec![1, 2, 3, 4]);
    }

    #[cfg(not(feature = "wasm"))]
    #[test]
    fn owned_texture_uploads_move_pixels_and_preserve_valid_pending_values() {
        let _ = take_input();
        let pixels = vec![1, 2, 3, 4];
        let allocation = pixels.as_ptr();
        crate::set_texture_owned("image", 1, 1, pixels, "asset").unwrap();
        assert!(crate::set_texture_owned("image", 2, 2, vec![0; 4], "asset").is_err());
        assert!(crate::set_texture_owned("image", 1, 1, vec![0; 4], &"x".repeat(4097)).is_err());
        let input = take_input();
        assert_eq!(input.textures["image"].2.as_ptr(), allocation);
        assert_eq!(input.textures["image"].2, vec![1, 2, 3, 4]);
        assert_eq!(input.textures["image"].3.as_deref(), Some("asset"));

        crate::set_texture_owned("image", 1, 1, vec![0; 4], "old").unwrap();
        let latest = vec![5, 6, 7, 8];
        let latest_allocation = latest.as_ptr();
        crate::set_texture_owned("image", 1, 1, latest, "new").unwrap();
        let input = take_input();
        assert_eq!(input.textures["image"].2.as_ptr(), latest_allocation);
        assert_eq!(input.textures["image"].3.as_deref(), Some("new"));
        assert!(take_input().textures.is_empty());
    }

    #[cfg(not(feature = "wasm"))]
    #[test]
    fn owned_plane_upload_moves_pixels_and_rejects_invalid_replacements() {
        let _ = take_input();
        let pixels = vec![1, 2, 3, 4];
        let allocation = pixels.as_ptr();
        crate::set_model_media_texture_owned("plane", 1, 1, pixels).unwrap();
        assert!(crate::set_model_media_texture_owned("plane", 2, 2, vec![0; 4]).is_err());
        let input = take_input();
        assert_eq!(input.model_textures["plane"].2.as_ptr(), allocation);
        assert_eq!(input.model_textures["plane"].2, vec![1, 2, 3, 4]);
        assert!(input.textures.is_empty());
        assert!(take_input().model_textures.is_empty());
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

    fn light_descriptor(key: &str, signature: &str) -> ModelDescriptorDto {
        ModelDescriptorDto {
            resource_version: crate::protocol::MODEL_DESCRIPTOR_VERSION.to_owned(),
            resource_key: key.to_owned(),
            scene_version: Some(crate::protocol::MODEL_SCENE_IR_V2.to_owned()),
            signature: signature.to_owned(),
            extent: 2.0,
            aabb: None,
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
        // 同 key 不同内容：冲突，且保留旧 payload。
        assert_eq!(
            queue_model_asset(descriptor("v2:abc", "changed-content", 2.0)),
            AssetRegistration::Conflict
        );
        assert!(model_asset_registered("v2:abc"));
        clear_model_assets();
    }

    #[test]
    fn descriptor_declaration_is_idempotent_and_conflict_aware() {
        clear_model_assets();
        let dto = light_descriptor("v2:light", "light");
        assert!(declare_model_descriptor_dto(dto.clone()).is_ok());
        assert!(declare_model_descriptor_dto(dto.clone()).is_ok());
        assert!(model_descriptor_declared("v2:light"));
        // 声明不等于 payload 驻留：cold 是合法状态。
        assert!(!model_asset_registered("v2:light"));

        // 同 key 不同**内容身份**仍稳定冲突（签名不同 ⇒ 属于另一份内容）。
        // 取 `ight` 是因为 key 必须以 signature 结尾，`v2:light` 同时以 `light` 和 `ight` 结尾，
        // 因此能穿过 DTO 校验、只在注册表这一层被判定为同 key 不同签名。
        let mut conflicting = dto.clone();
        conflicting.signature = "ight".into();
        conflicting.aabb = Some(crate::protocol::ModelAabbDto {
            min: [-1.0, -1.0, -1.0],
            max: [1.0, 1.0, 1.0],
        });
        assert_eq!(
            declare_model_descriptor_dto(conflicting),
            Err("Model resource key conflict")
        );
        // 冲突不改变已声明身份（仍无 payload，bounds 仍是原声明）。
        assert!(existing_model_metadata("v2:light").is_some_and(|meta| meta.3.is_none()));
        clear_model_assets();
    }

    /// 回归：派生 bounds 的浮点末位差异不得把同一内容判成冲突。
    ///
    /// 前端 `v2SceneAabb`（f64）与 Rust `prepare_snapshot`（f32）是两条独立派生路径。
    /// 曾把 extent/AABB 纳入 `same_identity` 的精确比较，导致 22 个模型有 15 个在
    /// `prepare_and_register_model_resource` 报 `Model resource key conflict`
    /// （2026-10-24，change: 2026-10-23-scale-canvas-media-residency）。
    #[test]
    fn descriptor_identity_ignores_derived_bounds_precision() {
        clear_model_assets();
        let declared = light_descriptor("v2:precision", "precision");
        assert!(declare_model_descriptor_dto(declared.clone()).is_ok());
        // 同一身份、bounds 只差 f32 末位（前端 double → wire f32 的必然结果）。
        let mut redundant = declared.clone();
        redundant.extent = 2.000_000_2;
        redundant.aabb = Some(crate::protocol::ModelAabbDto {
            min: [-1.000_000_1, -1.0, -1.0],
            max: [1.000_000_1, 1.0, 1.0],
        });
        assert!(
            declare_model_descriptor_dto(redundant).is_ok(),
            "派生 bounds 的精度差不是内容冲突"
        );
        // 首次声明的 bounds 保持不变（后到的近似值不覆盖权威派生）。
        assert!(existing_model_metadata("v2:precision").is_some_and(|meta| meta.3.is_none()));
        clear_model_assets();
    }

    #[test]
    fn descriptor_validation_rejects_mismatched_identity() {
        clear_model_assets();
        let mut dto = light_descriptor("v2:abc", "different");
        assert_eq!(
            declare_model_descriptor_dto(dto.clone()),
            Err("Model resource key/signature mismatch")
        );
        dto.signature = "abc".into();
        dto.resource_version = "woohaa-model-descriptor-v0".into();
        assert_eq!(
            declare_model_descriptor_dto(dto.clone()),
            Err("Unknown model descriptor version")
        );
        dto.resource_version = crate::protocol::MODEL_DESCRIPTOR_VERSION.to_owned();
        dto.scene_version = Some("woohaa-model-scene-ir-v1".into());
        assert_eq!(
            declare_model_descriptor_dto(dto),
            Err("Unsupported model scene version")
        );
        clear_model_assets();
    }

    #[test]
    fn missing_model_descriptor_reports_only_undeclared_keys() {
        clear_model_assets();
        let reference = crate::protocol::ModelReference { ground_anchor_local: None, part_rotations: None,
            scene_version: Some(crate::protocol::MODEL_SCENE_IR_V2.to_owned()),
            resource_key: "v2:missing".to_owned(),
            signature: "missing".to_owned(),
        };
        let scene = Scene {
            nodes: vec![crate::protocol::GraphNode {
                chrome: crate::protocol::NodeChrome::Card,
                shared_world_instance: None,
                world_camera: None,
                history_strip: None,
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
                progress_started_at: None,
                busy: false,
                texture: false,
                media_loading: false,
                resizable: false,
                ghost: false,
                card_label: None,
                model: Some(reference),
            }],
            ..Scene::default()
        };
        assert_eq!(
            missing_model_descriptor(&scene).as_deref(),
            Some("v2:missing")
        );
        // 只声明 descriptor 就足以让场景被接受：payload 未驻留是合法 cold。
        assert!(declare_model_descriptor_dto(light_descriptor("v2:missing", "missing")).is_ok());
        assert!(missing_model_descriptor(&scene).is_none());
        assert!(!model_asset_registered("v2:missing"));
        clear_model_assets();
    }

    #[test]
    fn scene_reference_protects_only_descriptors_not_payloads() {
        clear_model_assets();
        // 场景引用一个已注册的 payload：它只保护 descriptor，不保护 payload。
        let protected = "v2:scene-only";
        queue_model_asset(descriptor(protected, "scene-only", 1.0));
        assert!(model_asset_registered(protected));
        queue_scene(Scene {
            nodes: vec![crate::protocol::GraphNode {
                chrome: crate::protocol::NodeChrome::Card,
                shared_world_instance: None,
                world_camera: None,
                history_strip: None,
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
                progress_started_at: None,
                busy: false,
                texture: false,
                media_loading: false,
                resizable: false,
                ghost: false,
                card_label: None,
                model: Some(crate::protocol::ModelReference { ground_anchor_local: None, part_rotations: None,
                    scene_version: Some(crate::protocol::MODEL_SCENE_IR_V2.to_owned()),
                    resource_key: protected.to_owned(),
                    signature: "scene-only".to_owned(),
                }),
            }],
            ..Scene::default()
        });
        // 场景引用只保护 descriptor：撤销 lease 后再注册一批 cold payload 超出预算，
        // 被场景引用的 payload 也必须能被淘汰（否则 1000 个离屏模型会锁死重型 IR）。
        for index in 0..(MODEL_ASSET_MAX_ENTRIES + 8) {
            set_model_payload_leases(std::collections::HashSet::new());
            let key = format!("v2:pressure-{index}");
            queue_model_asset(descriptor(&key, &format!("pressure-{index}"), 1.0));
        }
        set_model_payload_leases(std::collections::HashSet::new());
        assert!(
            !model_asset_registered(protected),
            "场景引用不得阻止 payload 淘汰"
        );
        // 但 descriptor 仍在，引用依然是合法 cold：场景不会因 payload 不在而拒绝整帧。
        assert!(model_descriptor_declared(protected));
        clear_model_assets();
    }

    #[test]
    fn first_scene_can_register_more_models_than_the_idle_cache_budget() {
        // change: 2026-10-23-scale-canvas-media-residency —— 注册不淘汰、场景接受点回收
        // 未 lease 的 payload；场景引用只保护 descriptor。
        clear_model_assets();
        let count = MODEL_ASSET_MAX_ENTRIES + 4;
        let mut nodes = Vec::new();
        for index in 0..count {
            let signature = format!("first-{index}");
            let key = format!("v2:{signature}");
            queue_model_asset(descriptor(&key, &signature, 1.0));
            let node: crate::protocol::GraphNode = serde_json::from_value(serde_json::json!({
                "id": format!("object-{index}"), "type": "model",
                "x": index as f32 * 260.0, "y": 0.0, "width": 248.0, "height": 232.0,
                "model": { "resourceKey": key, "signature": signature }
            }))
            .unwrap();
            nodes.push(node);
        }
        let scene = Scene {
            nodes,
            ..Scene::default()
        };
        assert!(
            missing_model_descriptor(&scene).is_none(),
            "first-frame registration must not evict models before scene acceptance"
        );
        queue_scene(scene.clone());
        assert_eq!(
            model_assets_snapshot().len(),
            count,
            "first-frame registration with live leases keeps every payload"
        );
        assert!(missing_model_descriptor(&scene).is_none());

        // 需求集合收敛后（lease 只留显式需求），未使用的 payload 才按预算回收；
        // descriptor 全部保留，因此仍是合法 cold 引用而不是 unknown resource。
        let mut next = scene.clone();
        next.nodes.truncate(1);
        set_model_payload_leases(["v2:first-0".to_owned()].into_iter().collect());
        queue_scene(next.clone());
        assert!(missing_model_descriptor(&next).is_none());
        assert!(
            model_assets_snapshot().len() <= MODEL_ASSET_MAX_ENTRIES,
            "unused payloads are reclaimed within the idle cache budget"
        );
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
                chrome: crate::protocol::NodeChrome::Card,
                shared_world_instance: None,
                world_camera: None,
                history_strip: None,
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
                progress_started_at: None,
                busy: false,
                texture: false,
                media_loading: false,
                resizable: false,
                ghost: false,
                card_label: None,
                model: Some(crate::protocol::ModelReference { ground_anchor_local: None, part_rotations: None,
                    scene_version: Some(crate::protocol::MODEL_SCENE_IR_V2.to_owned()),
                    resource_key: protected.to_owned(),
                    signature: "keep".to_owned(),
                }),
            }],
            ..Scene::default()
        });
        // 声明超出 descriptor 上限的条目：场景引用的 descriptor 不得被逐出。
        for index in 0..(MODEL_DESCRIPTOR_MAX_ENTRIES + 4) {
            let key = format!("v2:sig-{index}");
            assert!(
                declare_model_descriptor_dto(light_descriptor(&key, &format!("sig-{index}")))
                    .is_ok()
            );
        }
        assert!(
            model_descriptor_declared(protected),
            "最近场景引用的 descriptor 不得被淘汰"
        );
        queue_scene(Scene::default());
        clear_model_assets();
    }

    #[test]
    fn payloads_without_lease_are_evicted_within_budget() {
        clear_model_assets();
        // 先声明并注册一份被 lease 的 payload。
        queue_model_asset(descriptor("v2:leased", "leased", 1.0));
        let leases: std::collections::HashSet<String> =
            ["v2:leased".to_owned()].into_iter().collect();
        let (retained, evicted) = set_model_payload_leases(leases);
        assert_eq!((retained, evicted.len()), (1, 0));
        assert!(model_asset_registered("v2:leased"));

        // 注册远超条目上限的 cold payload：lease 内的条目必须保留。
        for index in 0..(MODEL_ASSET_MAX_ENTRIES + 8) {
            let key = format!("v2:cold-{index}");
            queue_model_asset(descriptor(&key, &format!("cold-{index}"), 1.0));
            // 每轮都撤销 cold 的临时 lease，只保留显式 lease。
            set_model_payload_leases(["v2:leased".to_owned()].into_iter().collect());
        }
        assert!(
            model_asset_registered("v2:leased"),
            "lease 内的 payload 不得被新到者或计数预算淘汰"
        );
        let stats = asset_registry_stats();
        assert!(
            stats.payloads <= MODEL_ASSET_MAX_ENTRIES,
            "payload 表受条目上限约束"
        );
        assert!(
            stats.payload_evictions > 0,
            "无 lease 的 cold payload 应被淘汰"
        );
        assert!(
            stats.descriptors > stats.payloads,
            "descriptor 保留、payload 淘汰"
        );
        // cold payload 的 descriptor 仍支持轻量引用与查询。
        assert!(model_descriptor_declared("v2:cold-0"));
        clear_model_assets();
    }

    #[test]
    fn releasing_a_lease_makes_the_payload_evictable() {
        clear_model_assets();
        queue_model_asset(descriptor("v2:temp", "temp", 1.0));
        assert!(model_asset_registered("v2:temp"));
        // 撤销 lease 后注册大量新 cold payload，旧 payload 才可被淘汰。
        for index in 0..(MODEL_ASSET_MAX_ENTRIES + 8) {
            let key = format!("v2:new-{index}");
            set_model_payload_leases(std::collections::HashSet::new());
            queue_model_asset(descriptor(&key, &format!("new-{index}"), 1.0));
        }
        set_model_payload_leases(std::collections::HashSet::new());
        assert!(
            !model_asset_registered("v2:temp"),
            "失去 lease 后 payload 应按预算淘汰"
        );
        // descriptor 仍在：后续 acquire 可重新准备，不产生 unknown-resource。
        assert!(model_descriptor_declared("v2:temp"));
        clear_model_assets();
    }

    #[test]
    fn diagnostics_report_descriptor_and_payload_counts() {
        clear_model_assets();
        queue_model_asset(descriptor("v2:a", "a", 1.0));
        assert!(declare_model_descriptor_dto(light_descriptor("v2:b", "b")).is_ok());
        let json: serde_json::Value =
            serde_json::from_str(&model_asset_diagnostics()).expect("diagnostics json");
        assert_eq!(json["descriptors"], 2);
        assert_eq!(json["payloads"], 1);
        assert_eq!(json["cold"], 1);
        assert_eq!(json["leased"], 1);
        clear_model_assets();
    }
}
