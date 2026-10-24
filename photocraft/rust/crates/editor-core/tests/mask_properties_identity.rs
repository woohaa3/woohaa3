use photocraft_embed_editor::identity::{canonicalize,content_hash};
#[test]
fn shared_mask_properties_identity_fixtures() {
    let path=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/mask-properties-identity.json");
    let cases:serde_json::Value=serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    for case in cases.as_array().unwrap() {
        assert_eq!(canonicalize(&case["content"]),case["canonical"].as_str().map(str::to_owned),"{}",case["name"]);
        assert_eq!(content_hash(&case["content"]),case["hash"].as_str().map(str::to_owned),"{}",case["name"]);
    }
}
