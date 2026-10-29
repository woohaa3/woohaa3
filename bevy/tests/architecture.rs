//! 轻量模块边界审计（change: refactor-bevy-runtime-modules，任务 6.1 / design D8）。
//!
//! 只断言稳定边界，不用任意行数指标：
//! - `lib.rs` 不得定义 ECS system/resource/component；
//! - `protocol.rs` 不得依赖 Bevy / wasm-bindgen；
//! - `canvas2d` / `model3d` 不得依赖 bridge / wasm-bindgen，且互不导入；
//! - WASM 导出集合固定为五个。

use std::fs;
use std::path::{Path, PathBuf};

fn src_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn read(relative: &str) -> String {
    fs::read_to_string(src_dir().join(relative))
        .unwrap_or_else(|error| panic!("无法读取 {relative}: {error}"))
}

fn wasm_facade_source() -> String {
    [read("lib.rs"), read("texture_upload.rs")].join("\n")
}

/// 去掉行注释与块注释，避免解释性提及触发误报。
fn strip_comments(source: &str) -> String {
    let without_block = {
        let mut out = String::new();
        let mut rest = source;
        while let Some(start) = rest.find("/*") {
            out.push_str(&rest[..start]);
            match rest[start..].find("*/") {
                Some(end) => rest = &rest[start + end + 2..],
                None => {
                    rest = "";
                    break;
                }
            }
        }
        out.push_str(rest);
        out
    };
    without_block
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn assert_absent(relative: &str, forbidden: &[&str]) {
    let source = strip_comments(&read(relative));
    for needle in forbidden {
        assert!(!source.contains(needle), "{relative} 不应包含 {needle}");
    }
}

/// 对某个目录下**每个** `.rs` 文件断言禁用标记
/// （change: refactor-bevy-rust-file-size —— 模块拆分为目录后逐文件守卫）。
fn assert_absent_dir(relative_dir: &str, forbidden: &[&str]) {
    let mut files = Vec::new();
    collect_rs(&src_dir().join(relative_dir), &mut files);
    assert!(!files.is_empty(), "{relative_dir} 下应有 Rust 源文件");
    for file in files {
        let source = strip_comments(&fs::read_to_string(&file).expect("read scoped file"));
        for needle in forbidden {
            assert!(!source.contains(needle), "{file} 不应包含 {needle}");
        }
    }
}

fn collect_rs(dir: &Path, out: &mut Vec<String>) {
    for entry in fs::read_dir(dir).expect("read dir") {
        let entry = entry.expect("dir entry");
        let path = entry.path();
        if path.is_dir() {
            collect_rs(&path, out);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            out.push(path.to_string_lossy().into_owned());
        }
    }
}

/// 同 [`collect_rs`]，但目录不存在时跳过（例如当前仓库没有 `examples/`）。
fn collect_rs_if_exists(dir: &Path, out: &mut Vec<String>) {
    if dir.is_dir() {
        collect_rs(dir, out);
    }
}

#[test]
fn lib_is_facade_without_ecs_definitions() {
    let source = strip_comments(&read("lib.rs"));
    for needle in [
        "Resource",
        "Component",
        "Query<",
        "Res<",
        "ResMut<",
        "Commands",
        "fn setup",
        "fn sync_",
        "add_systems",
        "Plugin",
    ] {
        assert!(
            !source.contains(needle),
            "lib.rs 只应是 WASM facade，不应定义 {needle}"
        );
    }
    // facade 转发全部导出（新增镜头截图 request/poll，见
    // change: add-model-editor-gizmo-shot-capture；新增模型资源注册，见
    // change: optimize-model-scene-snapshot-hot-path；新增 2D interaction 查询，见
    // change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）。
    for export in [
        "set_texture",
        "set_scene",
        "rendered_revision",
        "is_ready",
        "start",
        "request_shot_capture",
        "poll_shot_capture",
        "shot_diagnostics",
        "query_point_hit",
        "query_marquee",
        "query_probe",
        "query_drop_target",
        "query_composite_asset_scopes",
        "prepare_and_register_model_resource",
        "declare_model_resource",
        "set_model_payload_leases",
        "model_asset_diagnostics",
        "query_model_pick",
        "query_gizmo_hit",
        "query_composite_asset_item_pick",
        "query_composite_asset_item_bounds",
        // change: 2026-10-10-optimize-canvas-interaction-hot-path —— 纯视口增量 + 能力/工作计数。
        "set_viewport",
        "set_observer",
        "observer_capability",
        "set_positions",
        "position_capability",
        "base_scene_generation",
        "viewport_capability",
        // change: 2026-10-15-add-film-set-overview-lod —— scene wire 能力字符串。
        "scene_capability",
        "canvas_work_diagnostics",
    ] {
        assert!(source.contains(export), "lib.rs 缺少导出 {export}");
    }
}

#[test]
fn wasm_exports_are_exactly_thirty_four() {
    let source = wasm_facade_source();
    // 只统计真正标记函数的属性行（doc 里的行内引用带反引号，不计入）。
    // 5 个基础导出 + request_shot_capture/poll_shot_capture（change:
    // 2026-10-07-remove-residual-compatibility，替换旧 request_capture/poll_capture）
    // + shot_diagnostics（change: add-reusable-bevy-shot-camera）
    // + query_point_hit/query_marquee/query_probe/query_model_pick/query_gizmo_hit/
    //   prepare_and_register_model_resource/model_asset_diagnostics
    //   （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）。
    // + set_film_set_texture（change: 2026-10-08-make-film-set-model-only 片场媒体平面）。
    // + query_composite_asset_item_pick / query_composite_asset_item_bounds
    //   （change: 2026-10-09-add-film-set-object-motion-and-editing）。
    // + set_viewport / base_scene_generation / viewport_capability / canvas_work_diagnostics
    //   （change: 2026-10-10-optimize-canvas-interaction-hot-path）。
    // + query_drop_target / query_composite_asset_scopes
    //   （change: 2026-10-12-align-film-set-scope-with-isometric-grid drop/scope 查询）。
    // + set_positions / position_capability
    //   （change: 2026-10-12-optimize-canvas-model-lod-and-interactions 原子位置预览）。
    // + scene_capability（change: 2026-10-15-add-film-set-overview-lod 片场总览 LOD 协议升级）。
    // + set_observer / observer_capability（聚焦朝向增量，旧 WASM 可缺省回退 full）。
    // + declare_model_resource / set_model_payload_leases
    //   （change: 2026-10-23-scale-canvas-media-residency —— descriptor 声明与 payload lease 分离）。
    // + request_history_thumbnail / poll_history_thumbnail（现有历史缩略图请求与回读）。
    // 导出属性有两种写法，都是 wasm-bindgen 导出，必须一起计数：
    // - `#[wasm_bindgen]`：仅 wasm 编译的条目；
    // - `#[cfg_attr(feature = "wasm", wasm_bindgen)]`：wasm 与 native 共享实现、只在 wasm
    //   导出（change: 2026-10-14-migrate-canvas-to-tauri-native-bevy，P2 3.1）。
    let count = source
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            trimmed == "#[wasm_bindgen]"
                || trimmed == r#"#[cfg_attr(feature = "wasm", wasm_bindgen)]"#
        })
        .count();
    assert_eq!(count, 34, "WASM 导出数量必须固定为 34，实际 {count}");
}

#[test]
fn wasm_facade_exports_have_stable_types_and_build_template_declarations() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let types = fs::read_to_string(root.join("web/frontend/src/bevy-wasm/woohaa_bevy_canvas.d.ts"))
        .unwrap();
    let template = fs::read_to_string(root.join("scripts/build-bevy-wasm.mjs")).unwrap();
    let source = wasm_facade_source();
    let mut exported = false;
    for line in source.lines() {
        if line.trim() == "#[wasm_bindgen]"
            || line.trim() == r#"#[cfg_attr(feature = "wasm", wasm_bindgen)]"#
        {
            exported = true;
        } else if exported && line.starts_with("pub fn ") {
            let name = line
                .strip_prefix("pub fn ")
                .unwrap()
                .split('(')
                .next()
                .unwrap();
            let declaration = format!("export function {name}(");
            assert!(types.contains(&declaration), "stable d.ts missing {name}");
            assert!(
                template.contains(&declaration),
                "build template missing {name}"
            );
            exported = false;
        }
    }
}

/// change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm —— 2D 共享几何与 interaction 查询
/// 必须是不依赖 ECS/wasm/bridge/渲染模块的纯逻辑，才能在 native 下单独测试并作为唯一事实源。
#[test]
fn canvas_query_is_pure_shared_geometry() {
    assert_absent_dir(
        "canvas_query",
        &[
            "crate::bridge",
            "crate::canvas2d",
            "canvas2d::",
            "crate::model3d",
            "wasm_bindgen",
            "web_sys",
            "js_sys",
            "Resource",
            "Component",
            "Query<",
            "Res<",
            "ResMut<",
            "Commands",
        ],
    );
}

#[test]
fn protocol_is_pure_serde() {
    // change: refactor-bevy-rust-file-size —— protocol 拆分为 facade + 子模块，
    // 逐个文件断言仍然不依赖 Bevy / wasm-bindgen / ECS。
    let mut files = Vec::new();
    collect_rs(&src_dir().join("protocol"), &mut files);
    assert!(!files.is_empty(), "protocol 目录下应有 Rust 源文件");
    for file in files {
        let source = strip_comments(&fs::read_to_string(&file).expect("read protocol file"));
        for needle in ["bevy", "wasm_bindgen", "Resource", "Component"] {
            assert!(!source.contains(needle), "{file} 不应包含 {needle}");
        }
    }
}

#[test]
fn bridge_does_not_depend_on_render_modules() {
    // change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm —— bridge 拆分为目录，逐个文件守卫。
    assert_absent_dir("bridge", &["bevy", "canvas2d", "model3d", "wasm_bindgen"]);
}

#[test]
fn canvas2d_does_not_import_bridge_or_model3d() {
    // change: refactor-bevy-rust-file-size —— canvas2d 拆分为多个文件，逐文件守卫。
    assert_absent_dir(
        "canvas2d",
        &[
            "crate::bridge",
            "crate::model3d",
            "model3d::",
            "wasm_bindgen",
        ],
    );
}

#[test]
fn model3d_does_not_import_bridge_or_canvas2d() {
    assert_absent(
        "model3d/mod.rs",
        &[
            "crate::bridge",
            "crate::canvas2d",
            "canvas2d::",
            "wasm_bindgen",
        ],
    );
    assert_absent_dir(
        "model3d/grid",
        &["crate::bridge", "crate::canvas2d", "wasm_bindgen"],
    );
    // `animation.rs` 是协议字符串 → 通用 enum 的纯映射，仍不得依赖 bridge/canvas2d/wasm；
    // change: play-model-animations-on-hover 后它还持有通用 playback 组件的类型别名
    // （`TransformAnimationPlayback`），因此允许 `Component` 标记。
    assert_absent(
        "model3d/animation.rs",
        &["crate::bridge", "crate::canvas2d", "wasm_bindgen"],
    );
}

/// change: add-reusable-bevy-shot-camera —— 可复用 shot camera 核心不得依赖领域协议/桥/DOM。
#[test]
fn shot_camera_core_has_no_domain_protocol_or_dom_dependency() {
    assert_absent_dir(
        "shot_camera",
        &[
            "crate::bridge",
            "crate::canvas2d",
            "crate::protocol",
            "canvas2d::",
            "wasm_bindgen",
            "web_sys",
            "js_sys",
            "yrs",
        ],
    );
}

/// change: refactor-bevy-reusable-components —— 通用组件不得依赖领域协议/桥/DOM。
#[test]
fn reusable_components_have_no_domain_protocol_or_dom_dependency() {
    for module in [
        "transform_animation.rs",
        "camera_transition.rs",
        "transform_gizmo.rs",
    ] {
        assert_absent(
            module,
            &[
                "crate::bridge",
                "crate::canvas2d",
                "crate::model3d",
                "crate::protocol",
                "canvas2d::",
                "wasm_bindgen",
                "web_sys",
                "js_sys",
                "yrs",
            ],
        );
    }
    // orbit_camera 拆分为目录（mod + wasm-only interaction）。
    assert_absent_dir(
        "orbit_camera",
        &[
            "crate::bridge",
            "crate::canvas2d",
            "crate::model3d",
            "crate::protocol",
            "canvas2d::",
            "wasm_bindgen",
            "web_sys",
            "js_sys",
            "yrs",
        ],
    );
    // 网格只依赖纯 plan + 配置注入；不得读 Scene/ThemeResource/editor layer。
    assert_absent_dir(
        "isometric_grid",
        &[
            "crate::bridge",
            "crate::canvas2d",
            "crate::protocol",
            "ThemeResource",
            "crate::theme",
            "wasm_bindgen",
            "web_sys",
        ],
    );
}

/// change: enhance-model-scene-authoring-api —— 共享模型构建与原生 renderer 的边界。
#[test]
fn shared_scene_builder_has_no_wasm_or_ecs_dependency() {
    // 浏览器与 native renderer 共用；不得依赖 wasm-bindgen 或 bridge。
    // change: refactor-bevy-rust-file-size —— scene 拆分为目录，逐文件守卫。
    assert_absent_dir(
        "model3d/scene",
        &["wasm_bindgen", "crate::bridge", "crate::canvas2d"],
    );
}

#[test]
fn renderer_protocol_does_not_execute_javascript_or_depend_on_bevy() {
    // 协议层只做 serde 与边界校验；不依赖 Bevy，也不含脚本执行。
    assert_absent(
        "renderer_protocol.rs",
        &[
            "wasm_bindgen",
            "new Function",
            "executeModelScript",
            "eval(",
        ],
    );
}

#[test]
fn preview_adapter_does_not_execute_javascript() {
    // 原生 worker 只接受 Scene IR，绝不执行 JavaScript。
    // change: refactor-bevy-rust-file-size —— preview 拆分为目录，逐文件守卫。
    assert_absent_dir(
        "model3d/preview",
        &["wasm_bindgen", "new Function", "executeModelScript"],
    );
}

#[test]
fn no_generic_utils_module() {
    let mut files = Vec::new();
    collect_rs(&src_dir(), &mut files);
    for file in files {
        assert!(
            !file.ends_with("utils.rs") && !file.ends_with("common.rs"),
            "不应存在通用杂物模块 {file}"
        );
    }
}

/// change: refactor-bevy-rust-file-size —— 拆分不得用 `include!` 等把源码藏进生成/拼接，
/// 也不得用 `#[path]` 指向 cap 之外的文件来绕过行数守卫。
#[test]
fn no_include_or_path_attribute_bypass_of_file_size_guard() {
    let crate_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    for scoped in [
        src_dir(),
        crate_root.join("tests"),
        crate_root.join("examples"),
    ] {
        collect_rs_if_exists(&scoped, &mut files);
    }
    for file in files {
        // 守卫文件自身在字符串字面量里列了这些标记，跳过以免自指。
        if Path::new(&file)
            .file_name()
            .is_some_and(|name| name == "architecture.rs")
        {
            continue;
        }
        let source = strip_comments(&fs::read_to_string(&file).expect("read scoped file"));
        for needle in ["include!", "include_str!", "include_bytes!", "#[path"] {
            assert!(
                !source.contains(needle),
                "{file} 不应使用 {needle} 绕过文件体积守卫"
            );
        }
    }
}

/// change: refactor-bevy-rust-file-size，任务 4.2 —— facade 导出与原生 renderer 入口稳定。
#[test]
fn facade_exports_and_renderer_entry_points_remain_stable() {
    // 模块根是 facade：声明子模块并再导出既有路径。
    let facades: [(&str, &[&str]); 8] = [
        (
            "canvas2d/mod.rs",
            &[
                "mod camera;",
                "mod init;",
                "mod render;",
                "mod textures;",
                "pub(crate) use render::{",
                "produce_card_geometry,",
                "pub(crate) use labels::{sync_canvas_labels, LabelRequests};",
                "pub(crate) use textures::sync_textures;",
            ],
        ),
        (
            "model3d/mod.rs",
            &[
                "mod layout;",
                "mod mesh;",
                "mod runtime;",
                "mod spawn;",
                "pub(crate) use runtime::",
            ],
        ),
        (
            "model3d/scene/mod.rs",
            &["mod aabb;", "mod build;", "mod materials;", "mod types;"],
        ),
        ("model3d/grid/mod.rs", &["mod lifecycle;", "mod plan;"]),
        (
            "model3d/preview/mod.rs",
            &[
                "mod render;",
                "mod stdio;",
                // 录制 worker 复用同一入口；两者必须一起导出，不能各留一份渲染实现
                // （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 3.2）。
                "pub use render::{render_preview, render_rgba};",
                "pub use stdio::{render_request_json, run_stdio};",
            ],
        ),
        (
            "protocol/mod.rs",
            &["mod model;", "mod scene;", "mod theme;"],
        ),
        (
            "isometric_grid/mod.rs",
            &["mod lifecycle;", "pub(crate) mod plan;"],
        ),
        ("orbit_camera/mod.rs", &["mod interaction;"]),
    ];
    for (file, expected) in facades {
        let source = read(file);
        for needle in expected {
            assert!(source.contains(needle), "{file} 缺少 facade 片段 {needle}");
        }
    }

    // 原生 renderer binary 仍从稳定入口启动 framed stdio 服务。
    let bin = fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("bin")
            .join("model-renderer.rs"),
    )
    .expect("read model-renderer bin");
    assert!(
        bin.contains("model3d::preview::run_stdio()"),
        "model-renderer 应以 model3d::preview::run_stdio() 为稳定入口"
    );
}

/// change: unify-application-theme-tokens，任务 4.5 —— authored 内容色与 theme palette 分离。
#[test]
fn authored_content_colors_stay_out_of_theme_palette() {
    // 模型材质解析/构建只读 Scene IR 自带的 color/material，不读 ThemeResource。
    // change: refactor-bevy-rust-file-size —— scene 拆分为目录，逐文件守卫。
    assert_absent_dir("model3d/scene", &["ThemeResource", "crate::theme"]);
    assert_absent_dir("model3d/preview", &["ThemeResource", "crate::theme"]);
    // 主题只承担 chrome：theme 模块不得包含模型 authored material 关键字。
    assert_absent(
        "theme.rs",
        &["baseColor", "base_color", "emissive", "StandardMaterial"],
    );
}

/// change: unify-application-theme-tokens —— 2D chrome 不得再生硬编码品牌色。
#[test]
fn canvas2d_chrome_reads_theme_not_literals() {
    // change: refactor-bevy-rust-file-size —— canvas2d 拆分为多个文件，逐文件守卫。
    assert_absent_dir(
        "canvas2d",
        &["0x16846c", "0x9aaea4", "0xd9e1dd", "0xabbdb3", "0x526b65"],
    );
}
