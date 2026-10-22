//! 智能对象源只做有界工程解析，不生成预览或有效像素。
use photocraft_doc::{
    Affine, ColorMode, Document, Layer, LayerContent, SampleType, Size, SmartObject, SmartSource,
};
use photocraft_project_verify::{VerifyErrorCode, smart_source, verify};
use std::sync::Arc;

fn document() -> Document {
    let mut doc = Document::new("源", Size::new(16, 12), ColorMode::Rgb, SampleType::U8);
    doc.layers.push(Layer::raster("空层", doc.pixel_format()));
    doc
}
fn save(doc: &Document) -> Vec<u8> {
    photocraft_format::save_to_bytes(doc, &Default::default()).unwrap()
}
fn source(bytes: Vec<u8>) -> SmartSource {
    SmartSource::Embedded {
        file_name: "源.PCRAFT".into(),
        bytes: Arc::new(bytes),
    }
}
fn code(source: &SmartSource) -> VerifyErrorCode {
    match smart_source::load(source) {
        Ok(_) => panic!("应拒绝该源"),
        Err(error) => error.code,
    }
}
fn replace_manifest(bytes: &[u8], change: impl FnOnce(&mut serde_json::Value)) -> Vec<u8> {
    let archive = photocraft_format::zip::ZipReader::new(bytes).unwrap();
    let mut manifest =
        serde_json::to_value(photocraft_format::read_manifest(bytes).unwrap()).unwrap();
    change(&mut manifest);
    let mut out = photocraft_format::zip::ZipWriter::new();
    for entry in &archive.entries {
        let data = if entry.name == "manifest.json" {
            serde_json::to_vec(&manifest).unwrap()
        } else {
            archive.read(entry, 1 << 20).unwrap()
        };
        out.add(&entry.name, &data).unwrap();
    }
    out.finish().unwrap()
}

#[test]
fn loads_layered_native_source_and_preserves_original_bytes() {
    let mut doc = document();
    doc.layers
        .push(Layer::group("组", vec![doc.layers[0].clone()]));
    let bytes = save(&doc);
    let input = source(bytes.clone());
    let loaded = smart_source::load(&input).unwrap();
    assert_eq!(loaded.summary.layer_count, 3);
    assert_eq!(loaded.summary.depth, 2);
    assert_eq!(
        loaded.document,
        photocraft_format::load_from_bytes_with(
            &bytes,
            &photocraft_format::LoadOptions {
                preserve_ids: true,
                ..Default::default()
            }
        )
        .unwrap()
    );
    assert_eq!(loaded.document.size, doc.size);
    let (
        SmartSource::Embedded {
            bytes: original, ..
        },
        SmartSource::Embedded {
            bytes: snapshot, ..
        },
    ) = (&input, &loaded.source)
    else {
        panic!()
    };
    assert!(Arc::ptr_eq(original, snapshot));
    let SmartSource::Embedded { bytes: after, .. } = input else {
        panic!()
    };
    assert_eq!(*after, bytes);
}
#[test]
fn rejects_linked_sources_and_names_without_entering_import_or_filesystem() {
    assert_eq!(
        code(&SmartSource::Linked {
            path: "/does/not/exist.pcraft".into()
        }),
        VerifyErrorCode::ExternalReference
    );
    let bytes = Arc::new(save(&document()));
    for name in [
        "x.psd",
        "x.png",
        "x.pcraft.png",
        "../x.pcraft",
        "C:x.pcraft",
        "x\\y.pcraft",
        ".pcraft",
        "\nx.pcraft",
    ] {
        assert_eq!(
            code(&SmartSource::Embedded {
                file_name: name.into(),
                bytes: bytes.clone()
            }),
            VerifyErrorCode::UnsupportedObject,
            "{name:?}"
        );
    }
    assert_eq!(
        code(&SmartSource::Embedded {
            file_name: format!("{}.pcraft", "字".repeat(201)),
            bytes
        }),
        VerifyErrorCode::UnsupportedObject
    );
}
#[test]
fn extension_cannot_admit_non_native_corrupt_or_empty_bytes() {
    assert_eq!(code(&source(vec![])), VerifyErrorCode::Empty);
    for bytes in [
        b"8BPS\0\x01".to_vec(),
        b"\x89PNG\r\n".to_vec(),
        b"not a bundle".to_vec(),
    ] {
        assert_eq!(code(&source(bytes)), VerifyErrorCode::NotAZip);
    }
    assert_eq!(
        code(&source(vec![
            0;
            photocraft_project_verify::limits::MAX_PROJECT_BYTES
                + 1
        ])),
        VerifyErrorCode::CompressedTooLarge
    );
}
#[test]
fn rejects_unsupported_mode_before_decoding_missing_layer_resources() {
    let bytes = save(&document());
    for (field, value) in [("mode", "Cmyk"), ("depth", "U16")] {
        let changed = replace_manifest(&bytes, |m| {
            m["document"][field] = serde_json::json!(value);
            m["document"]["layers"][0]["content"]["surface"]["tiles"] =
                serde_json::json!([{"tx":0,"ty":0,"hash":"0".repeat(64)}]);
        });
        // 若进入 tile 解码会报资源缺失；模式检查必须先返回未开放内容。
        assert_eq!(code(&source(changed)), VerifyErrorCode::UnsupportedObject);
    }
}
#[test]
fn accepts_nested_smart_only_in_source_adapter_and_keeps_regular_upload_closed() {
    let inner = source(save(&document()));
    let mut outer = document();
    outer.layers.push(Layer::new(
        "嵌套",
        LayerContent::Smart(SmartObject::new(inner, Affine::IDENTITY, None)),
    ));
    let bytes = save(&outer);
    let loaded = smart_source::load(&source(bytes.clone())).unwrap();
    assert_eq!(loaded.resources.document_count, 2);
    assert_eq!(loaded.resources.layer_count, 3);
    assert_eq!(loaded.resources.depth, 2);
    assert!(loaded.resources.decoded_bytes > 0);
    assert_eq!(
        verify(&bytes).unwrap_err().code,
        VerifyErrorCode::UnsupportedObject
    );
}
#[test]
fn cannot_bypass_group_count_depth_or_canvas_limits() {
    let mut doc = document();
    doc.layers = vec![doc.layers[0].clone(); 65];
    assert_eq!(code(&source(save(&doc))), VerifyErrorCode::TooManyLayers);
    let mut doc = document();
    let mut layer = doc.layers.pop().unwrap();
    for _ in 0..16 {
        layer = Layer::group("组", vec![layer]);
    }
    doc.layers.push(layer);
    assert_eq!(code(&source(save(&doc))), VerifyErrorCode::TooDeep);
    let bytes = save(&document());
    let changed = replace_manifest(&bytes, |m| {
        m["document"]["size"] = serde_json::json!({"width":8193,"height":1})
    });
    assert_eq!(code(&source(changed)), VerifyErrorCode::CanvasTooLarge);
}

fn nested(inner: Document) -> Document {
    let mut doc = document();
    doc.layers = vec![Layer::new(
        "嵌入",
        LayerContent::Smart(SmartObject::new(
            source(save(&inner)),
            Affine::IDENTITY,
            None,
        )),
    )];
    doc
}
#[test]
fn nested_sources_share_layer_and_combined_group_depth_limits() {
    let mut child = document();
    child.layers = vec![child.layers[0].clone(); 32];
    let mut parent = nested(child);
    parent.layers = vec![parent.layers[0].clone(); 2];
    // 每个源单独均不超过 64 层，但两棵子树加上父层总计 66 层。
    assert_eq!(code(&source(save(&parent))), VerifyErrorCode::TooManyLayers);
    let mut deep = document();
    for _ in 0..15 {
        deep = nested(deep);
    }
    let loaded = smart_source::load(&source(save(&deep))).unwrap();
    assert_eq!(loaded.resources.depth, 16);
    assert_eq!(loaded.resources.document_count, 16);
    assert_eq!(
        code(&source(save(&nested(deep.clone())))),
        VerifyErrorCode::TooDeep
    );
    let mut grouped = document();
    grouped.layers = vec![Layer::group("组", deep.layers)];
    assert_eq!(code(&source(save(&grouped))), VerifyErrorCode::TooDeep);
}
#[test]
fn nested_external_references_and_advanced_smart_features_are_rejected() {
    let good = nested(document());
    for mutation in 0..7 {
        let mut doc = good.clone();
        let LayerContent::Smart(smart) = &mut doc.layers[0].content else {
            panic!()
        };
        match mutation {
            0 => {
                smart.source = SmartSource::Linked {
                    path: "/not/read.pcraft".into(),
                }
            }
            1 => smart.transform = Affine::scale(0.0),
            2 => smart.smart_filters.push(photocraft_doc::SmartFilter {
                command: "filter.blur".into(),
                params: serde_json::json!({}),
                visible: true,
                blend: photocraft_doc::BlendMode::Normal,
                opacity: 1.0,
            }),
            3 => smart.psd_raw = Some(Arc::new(vec![])),
            4 => smart.perspective = Some([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]),
            5 => smart.transform = Affine::scale(1024.0),
            _ => smart.transform = Affine::translate(i32::MAX as f64, 0.0),
        }
        let expected = if mutation == 0 {
            VerifyErrorCode::ExternalReference
        } else if mutation >= 5 {
            VerifyErrorCode::CanvasTooLarge
        } else {
            VerifyErrorCode::UnsupportedObject
        };
        assert_eq!(code(&source(save(&doc))), expected, "mutation={mutation}");
    }
}
#[test]
fn shared_contents_identity_requires_same_source_but_independent_copies_can_differ() {
    let mut parent = nested(document());
    let mut duplicate = parent.layers[0].clone();
    let mut child = document();
    child.name = "其它内容".into();
    let LayerContent::Smart(smart) = &mut duplicate.content else {
        panic!()
    };
    smart.source = source(save(&child));
    parent.layers.push(duplicate);
    assert_eq!(
        code(&source(save(&parent))),
        VerifyErrorCode::InvalidManifest
    );
    let LayerContent::Smart(smart) = &mut parent.layers[1].content else {
        panic!()
    };
    smart.contents_id = photocraft_doc::SmartContentsId::fresh();
    assert_eq!(
        smart_source::load(&source(save(&parent)))
            .unwrap()
            .resources
            .document_count,
        3
    );
}

#[test]
fn explicit_project_verification_shares_root_and_source_budget_and_cli_mode() {
    let mut child = document();
    child.layers = (0..31).map(|_| Layer::raster("空",child.pixel_format())).collect();
    let input = source(save(&child));
    let mut parent = document();
    let object = Layer::new("对象",LayerContent::Smart(SmartObject::new(input,Affine::IDENTITY,None)));
    parent.layers = vec![object.clone(),object.duplicate()];
    let bytes = save(&parent);
    let summary = smart_source::verify_project(&bytes).unwrap();
    assert_eq!(summary.layer_count,2);
    assert_eq!(summary.object_kinds,vec!["smart"]);
    assert!(verify(&bytes).is_err());
    use std::io::Write;
    use std::process::{Command,Stdio};
    for embedded in [false,true] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_photocraft-project-verify"));
        if embedded {command.arg("--embedded-smart");}
        let mut process = command.stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        process.stdin.take().unwrap().write_all(&bytes).unwrap();
        let output = process.wait_with_output().unwrap();
        assert_eq!(output.status.success(),embedded);
        let value:serde_json::Value=serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["ok"],embedded);
    }
    parent.layers.push(parent.layers[0].duplicate());
    assert_eq!(smart_source::verify_project(&save(&parent)).unwrap_err().code,VerifyErrorCode::TooManyLayers);
}
