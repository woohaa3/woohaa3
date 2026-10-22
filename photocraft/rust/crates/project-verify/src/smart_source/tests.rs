use super::*;
use photocraft_doc::{Affine, ColorMode, SampleType, Size, SmartObject};
fn source() -> SmartSource {
    let mut child = Document::new("子", Size::new(1, 1), ColorMode::Rgb, SampleType::U8);
    child
        .layers
        .push(Layer::raster("空层", child.pixel_format()));
    // 非图像资源足以区分 ZIP 压缩字节和实际 zstd 解压字节。
    child.metadata.exif = Some(std::sync::Arc::new(vec![0; 32768]));
    let inner = SmartSource::Embedded {
        file_name: "child.pcraft".into(),
        bytes: std::sync::Arc::new(
            photocraft_format::save_to_bytes(&child, &Default::default()).unwrap(),
        ),
    };
    let mut parent = Document::new("父", Size::new(1, 1), ColorMode::Rgb, SampleType::U8);
    parent.layers.push(Layer::new(
        "智能对象",
        LayerContent::Smart(SmartObject::new(inner, Affine::IDENTITY, None)),
    ));
    SmartSource::Embedded {
        file_name: "parent.pcraft".into(),
        bytes: std::sync::Arc::new(
            photocraft_format::save_to_bytes(&parent, &Default::default()).unwrap(),
        ),
    }
}
fn run(
    input: &SmartSource,
    budget: &Budget,
) -> Result<(ProjectSummary, std::sync::Arc<Document>), VerifyError> {
    load_in(input, Scope { budget, depth: 1 })
}
#[test]
fn nested_sources_share_zip_entries_and_archive_bytes_before_allocating() {
    let input = source();
    let full = load(&input).unwrap();
    assert_eq!(full.resources.document_count, 2);
    assert!(full.resources.entry_count > full.summary.entry_count);
    let budget = Budget {
        entry_limit: full.resources.entry_count - 1,
        ..Default::default()
    };
    assert_eq!(
        run(&input, &budget).unwrap_err().code,
        VerifyErrorCode::TooManyEntries
    );
    let budget = Budget {
        archive_limit: full.resources.archive_bytes - 1,
        ..Default::default()
    };
    assert_eq!(
        run(&input, &budget).unwrap_err().code,
        VerifyErrorCode::DecompressedTooLarge
    );
    assert!(budget.used.borrow().archive_bytes <= budget.archive_limit);
}
#[test]
fn zstd_output_and_manifest_bytes_share_one_budget_across_source_tree() {
    let input = source();
    let full = load(&input).unwrap();
    assert!(full.resources.decoded_bytes > full.resources.archive_bytes + 30000);
    let budget = Budget {
        decoded_limit: full.resources.decoded_bytes - 1,
        ..Default::default()
    };
    assert_eq!(
        run(&input, &budget).unwrap_err().code,
        VerifyErrorCode::DecompressedTooLarge
    );
    assert!(budget.decode_exceeded.get());
    assert!(budget.used.borrow().decoded_bytes <= budget.decoded_limit);
    let budget = Budget {
        decoded_limit: full.resources.decoded_bytes,
        ..Default::default()
    };
    run(&input, &budget).unwrap();
    assert_eq!(
        budget.used.borrow().decoded_bytes,
        full.resources.decoded_bytes
    );
}
#[test]
fn source_byte_adapter_charges_each_decode_and_stops_before_limit_plus_one() {
    let compressed = ruzstd::encoding::compress_to_vec(
        [7_u8; 8192].as_slice(),
        ruzstd::encoding::CompressionLevel::Fastest,
    );
    let mut zip = photocraft_format::zip::ZipWriter::new();
    zip.add("blobs/test.zst", &compressed).unwrap();
    let bytes = zip.finish().unwrap();
    let archive = ZipReader::new(&bytes).unwrap();
    let budget = Budget {
        decoded_limit: 8192,
        ..Default::default()
    };
    let reader = BudgetSource {
        archive: &archive,
        scope: Scope {
            budget: &budget,
            depth: 1,
        },
    };
    reader.get("blobs/test.zst", 1 << 20).unwrap();
    assert_eq!(budget.used.borrow().decoded_bytes, 8192);
    // 上游缓存命中不会再次调用 get；真正再次解码必须再次计费。
    assert!(reader.get("blobs/test.zst", 1 << 20).is_err());
    assert_eq!(budget.used.borrow().decoded_bytes, 8192);
    let budget = Budget {
        decoded_limit: 8191,
        ..Default::default()
    };
    let reader = BudgetSource {
        archive: &archive,
        scope: Scope {
            budget: &budget,
            depth: 1,
        },
    };
    assert!(reader.get("blobs/test.zst", 1 << 20).is_err());
    assert!(budget.decode_exceeded.get());
    assert_eq!(budget.used.borrow().decoded_bytes, 0);
}
#[test]
fn upstream_blob_cache_reuse_does_not_charge_a_second_decode() {
    let mut document =
        Document::new("共享资源", Size::new(1, 1), ColorMode::Rgb, SampleType::U8);
    document
        .layers
        .push(Layer::raster("空层", document.pixel_format()));
    let resource = std::sync::Arc::new(vec![0; 32768]);
    document.icc_profile = Some(resource.clone());
    document.metadata.exif = Some(resource);
    let bytes = photocraft_format::save_to_bytes(&document, &Default::default()).unwrap();
    let archive = ZipReader::new(&bytes).unwrap();
    let manifest = archive.read_by_name("manifest.json", 1 << 20).unwrap();
    let input = SmartSource::Embedded {
        file_name: "shared.pcraft".into(),
        bytes: std::sync::Arc::new(bytes),
    };
    let loaded = load(&input).unwrap();
    assert_eq!(
        loaded.resources.decoded_bytes,
        manifest.len() as u64 + 32768
    );
    assert!(std::sync::Arc::ptr_eq(
        loaded.document.icc_profile.as_ref().unwrap(),
        loaded.document.metadata.exif.as_ref().unwrap()
    ));
}
