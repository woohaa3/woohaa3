//! CPU-only diagnostic for a private normalized custom-mesh fixture. This is
//! native-only and never executes scripts or modifies source geometry.
use super::{mesh, quality::Quality, scene::ModelGeometry, simplification};
use bevy::platform::time::Instant;
use std::collections::BTreeMap;

#[derive(serde::Deserialize)]
struct Input {
    vertices: Vec<[f32; 3]>,
    faces: Vec<[u32; 3]>,
}

pub fn measure_json(json: &str) -> Result<serde_json::Value, String> {
    let input: Vec<Input> = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let mut rounds = Vec::new();
    for _ in 0..5 {
        let started = Instant::now();
        let mut original_triangles = 0;
        let mut low_triangles = 0;
        let mut high_bytes = 0;
        let mut low_bytes = 0;
        let mut generated = 0;
        let mut max_ms = 0.0_f64;
        let mut max_error = 0.0_f32;
        let mut fallbacks = BTreeMap::<String, usize>::new();
        for item in &input {
            let geometry = ModelGeometry::Mesh {
                vertices: item.vertices.clone(),
                faces: item.faces.clone(),
            };
            let high = mesh::build_mesh(&geometry).ok_or("invalid fixture mesh")?;
            original_triangles += high.indices().map_or(0, |i| i.len() / 3);
            high_bytes += high.get_vertex_buffer_size() + high.indices().map_or(0, |i| i.len() * 4);
            let begin = Instant::now();
            let low = match simplification::generate(&geometry, Quality::Low) {
                Ok(reduced) => {
                    generated += 1;
                    max_error = max_error.max(reduced.error);
                    reduced.mesh
                }
                Err(reason) => {
                    *fallbacks.entry(format!("{reason:?}")).or_default() += 1;
                    high
                }
            };
            max_ms = max_ms.max(begin.elapsed().as_secs_f64() * 1000.);
            low_triangles += low.indices().map_or(0, |i| i.len() / 3);
            low_bytes += low.get_vertex_buffer_size() + low.indices().map_or(0, |i| i.len() * 4);
        }
        rounds.push(
            serde_json::json!({ "meshes": input.len(), "generated": generated,
            "originalTriangles": original_triangles, "lowTriangles": low_triangles,
            "highMeshBytes": high_bytes, "lowMeshBytes": low_bytes, "fallbacks": fallbacks,
            "maxRelativeQuadricError": max_error, "maxJobMs": max_ms,
            "totalMs": started.elapsed().as_secs_f64() * 1000. }),
        );
    }
    Ok(
        serde_json::json!({ "algorithm": "meshoptimizer-0.6.2", "version": simplification::VERSION,
        "scope": "normalized authored mesh occurrences; not composed runtime instance or GPU timing",
        "maxVertices": simplification::MAX_VERTICES, "maxFaces": simplification::MAX_FACES,
        "cppWorkspaceActiveBytes": super::simplification_allocator::workspace_bytes().0,
        "cppWorkspacePeakBytes": super::simplification_allocator::workspace_bytes().1,
        "workspaceScope": "C++ temporary allocations with headers; excludes Rust validation/mesh buffers",
        "rounds": rounds }),
    )
}
