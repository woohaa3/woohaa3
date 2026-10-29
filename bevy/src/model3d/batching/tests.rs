//! `batching::plan` / `build` 的单元测试（与实现分文件，避免业务源码超过 500 行门禁）。
use super::*;

    fn specs() -> Vec<ModelEntitySpec> {
        (0..8)
            .map(|i| ModelEntitySpec {
                id: format!("part-{i}"),
                parent: Some("group".into()),
                position: [i as f32, 0., 0.],
                rotation_radians: [0.; 3],
                scale: [2., 1., 0.5],
                geometry: Some(ModelGeometry::Box { size: [1.; 3] }),
                material_key: "opaque".into(),
                animation: None,
            })
            .collect()
    }
    #[test]
    fn preserves_identity_ranges_bounds_and_source() {
        let specs = specs();
        let original = specs.clone();
        let plans = plan(
            &specs,
            &HashSet::from(["opaque".into()]),
            &HashSet::new(),
            false,
            &HashSet::new(),
        )
        .plans;
        assert_eq!(plans.len(), 1);
        let batch = build(&plans[0], &specs, Quality::High).unwrap();
        assert_eq!(batch.ranges.len(), 8);
        assert_eq!(batch.source_mesh_builds, 1);
        let buffer_bytes = batch.mesh.get_vertex_buffer_size()
            + batch.mesh.indices().unwrap().len() * 4;
        assert_eq!(buffer_bytes, batch.source_buffer_bytes * 8);
        assert_eq!(batch.min, Vec3::new(-1., -0.5, -0.25));
        assert_eq!(batch.max, Vec3::new(8., 0.5, 0.25));
        for (i, range) in batch.ranges.iter().enumerate() {
            assert_eq!(range.id, format!("part-{i}"));
            assert_eq!(range.vertices.end - range.vertices.start, 24);
            assert_eq!(range.indices.end - range.indices.start, 36);
        }
        assert_eq!(batch.mesh.indices().unwrap().len(), 8 * 36);
        assert_eq!(specs, original);
    }
    #[test]
    fn independent_transparent_reflected_and_other_scopes_do_not_merge() {
        let mut specs = specs();
        specs[0].scale[0] = -1.;
        specs[1].material_key = "transparent".into();
        specs[2].parent = Some("other".into());
        let plans = plan(
            &specs,
            &HashSet::from(["opaque".into()]),
            &HashSet::from(["part-3".into()]),
            false,
            &HashSet::new(),
        )
        .plans;
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].parts, vec![4, 5, 6, 7]);
    }

    fn mesh_specs(
        colors: Option<Vec<[f32; 4]>>,
        uvs: Option<Vec<[f32; 2]>>,
    ) -> Vec<ModelEntitySpec> {
        (0..4)
            .map(|i| ModelEntitySpec {
                id: format!("mesh-{i}"),
                parent: Some("group".into()),
                position: [i as f32, 0., 0.],
                rotation_radians: [0.; 3],
                scale: [1.; 3],
                geometry: Some(ModelGeometry::Mesh {
                    vertices: vec![[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]],
                    faces: vec![[0, 1, 2]],
                    normals: None,
                    uvs: uvs.clone(),
                    colors: colors.clone(),
                }),
                material_key: "opaque".into(),
                animation: None,
            })
            .collect()
    }

    /// 声明总览 LOD 的片场可以同步合批自定义 Mesh：其几何恒为原始档，不存在异步简化结果。
    #[test]
    fn overview_roots_batch_uv_custom_meshes() {
        let specs = mesh_specs(None, Some(vec![[0., 0.], [1., 0.], [0., 1.]]));
        let opaque = HashSet::from(["opaque".to_string()]);
        assert!(plan(&specs, &opaque, &HashSet::new(), false, &HashSet::new()).plans.is_empty());
        let plans = plan(&specs, &opaque, &HashSet::new(), true, &HashSet::new()).plans;
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].parts.len(), 4);
        assert!(build(&plans[0], &specs, Quality::High).is_some());
    }

    fn nested_specs(group_rotation: [f32; 3]) -> Vec<ModelEntitySpec> {
        let mut specs: Vec<ModelEntitySpec> = (0..4)
            .map(|i| ModelEntitySpec {
                id: format!("leaf-{i}"),
                parent: Some("group".into()),
                position: [i as f32, 0., 0.],
                rotation_radians: [0.; 3],
                scale: [1.; 3],
                geometry: Some(ModelGeometry::Box { size: [1.; 3] }),
                material_key: "opaque".into(),
                animation: None,
            })
            .collect();
        specs.push(ModelEntitySpec {
            id: "group".into(),
            parent: None,
            position: [10., 0., 0.],
            rotation_radians: group_rotation,
            scale: [1.; 3],
            geometry: None,
            material_key: "opaque".into(),
            animation: None,
        });
        specs
    }

    /// 纯平移的父级分组会被平铺到根空间：同一材质的叶子部件合并成一个批次。
    #[test]
    fn overview_roots_flatten_translation_only_scopes() {
        let mut specs = nested_specs([0.; 3]);
        let opaque = HashSet::from(["opaque".to_string()]);
        let grouped = plan(&specs, &opaque, &HashSet::new(), false, &HashSet::new());
        assert_eq!(grouped.plans.len(), 1);
        assert_eq!(grouped.plans[0].parent.as_deref(), Some("group"));

        let planned = plan(&specs, &opaque, &HashSet::new(), true, &HashSet::new());
        assert_eq!(planned.plans.len(), 1);
        assert_eq!(planned.plans[0].parent, None);
        assert_eq!(planned.flatten.len(), 4);
        apply_flatten(&mut specs, &planned.flatten);
        for (i, spec) in specs.iter().take(4).enumerate() {
            assert_eq!(spec.parent, None);
            assert_eq!(spec.position, [10. + i as f32, 0., 0.]);
        }
        let batch = build(&planned.plans[0], &specs, Quality::High).unwrap();
        assert_eq!(batch.min.x, 9.5);
        assert_eq!(batch.max.x, 13.5);
    }

    /// 动态父级（例如片场 binding 根）是平铺屏障：只烘焙屏障以内的平移，批次仍挂在
    /// 该父级下，运行时写在它上面的摆放/显隐继续作用于整批。
    #[test]
    fn overview_roots_stop_flattening_at_dynamic_parents() {
        let mut specs = nested_specs([0.; 3]);
        let opaque = HashSet::from(["opaque".to_string()]);
        let barriers = HashSet::from(["group".to_string()]);
        let planned = plan(&specs, &opaque, &HashSet::new(), true, &barriers);
        assert_eq!(planned.plans.len(), 1);
        assert_eq!(planned.plans[0].parent.as_deref(), Some("group"));
        assert_eq!(planned.flatten.len(), 4);
        apply_flatten(&mut specs, &planned.flatten);
        for (i, spec) in specs.iter().take(4).enumerate() {
            assert_eq!(spec.parent.as_deref(), Some("group"));
            // 屏障自身的 +10 平移由运行时 transform 承担，不能烘焙进部件位置。
            assert_eq!(spec.position, [i as f32, 0., 0.]);
        }
    }

    /// 屏障本身即使带几何也不能入批：它的实体是运行时摆放/显隐的写入目标。
    #[test]
    fn barrier_roots_with_geometry_stay_individual() {
        let mut specs = specs();
        specs.insert(
            0,
            ModelEntitySpec {
                id: "group".into(),
                parent: None,
                position: [0.; 3],
                rotation_radians: [0.; 3],
                scale: [1.; 3],
                geometry: Some(ModelGeometry::Box { size: [1.; 3] }),
                material_key: "opaque".into(),
                animation: None,
            },
        );
        let planned = plan(
            &specs,
            &HashSet::from(["opaque".into()]),
            &HashSet::new(),
            true,
            &HashSet::from(["group".into()]),
        );
        assert_eq!(planned.plans.len(), 1);
        assert_eq!(planned.plans[0].parent.as_deref(), Some("group"));
        let ids: Vec<_> = planned.plans[0]
            .parts
            .iter()
            .map(|index| specs[*index].id.as_str())
            .collect();
        assert_eq!(ids.len(), 8);
        assert!(!ids.contains(&"group"));
    }

    /// 父级带旋转时不能平铺：父子变换无法无损回写成部件自身的欧拉角。
    #[test]
    fn rotated_scopes_stay_grouped() {
        let specs = nested_specs([0., 0.7, 0.]);
        let opaque = HashSet::from(["opaque".to_string()]);
        let planned = plan(&specs, &opaque, &HashSet::new(), true, &HashSet::new());
        assert!(planned.flatten.is_empty());
        assert_eq!(planned.plans.len(), 1);
        assert_eq!(planned.plans[0].parent.as_deref(), Some("group"));
    }

    /// 没有 UV 或带顶点色的 Mesh 不合批：构建要求 UV，批次也不烘焙顶点色。
    #[test]
    fn custom_meshes_without_uv_or_with_colors_stay_separate() {
        let opaque = HashSet::from(["opaque".to_string()]);
        let no_uv = mesh_specs(None, None);
        assert!(plan(&no_uv, &opaque, &HashSet::new(), true, &HashSet::new()).plans.is_empty());
        let colored = mesh_specs(
            Some(vec![[1., 1., 1., 1.]; 3]),
            Some(vec![[0., 0.], [1., 0.], [0., 1.]]),
        );
        assert!(plan(&colored, &opaque, &HashSet::new(), true, &HashSet::new()).plans.is_empty());
    }
