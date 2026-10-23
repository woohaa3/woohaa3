import bevy_pbr::render::{
    forward_io::{Vertex, VertexOutput, decompress_vertex},
    mesh_functions,
    mesh_view_bindings::{globals, view},
    view_transformations::position_world_to_clip,
};

@group(constants::MATERIAL_BIND_GROUP) @binding(0) var<uniform> color: vec4<f32>;
@group(constants::MATERIAL_BIND_GROUP) @binding(1) var<uniform> timing: vec4<f32>;
@group(constants::MATERIAL_BIND_GROUP) @binding(2) var<uniform> axis: vec4<f32>;

fn cycle() -> f32 {
    let clock = select(globals.time, timing.y, timing.y >= 0.0);
    return fract(elapsed(clock, timing.x) / 2.8);
}

fn elapsed(clock: f32, origin: f32) -> f32 {
    return (clock - origin + timing.w) % timing.w;
}

@vertex
fn vertex(source: Vertex) -> VertexOutput {
    let local = decompress_vertex(source, source.instance_index);
    var world = mesh_functions::get_world_from_local(source.instance_index) * vec4(local.position, 1.0);
    if local.uv.y > 2.5 {
        world = vec4(world.xyz + axis.xyz * min(cycle() * 2.8 / 2.2, 1.0), 1.0);
    }
    var out: VertexOutput;
    out.world_position = world;
    out.world_normal = vec3(0.0, 1.0, 0.0);
    out.position = position_world_to_clip(world.xyz);
    if local.uv.y < 2.5 {
        let along = position_world_to_clip(world.xyz + local.normal);
        let screen_delta = (along.xy / along.w - out.position.xy / out.position.w) * view.viewport.zw;
        let perpendicular = vec2(-screen_delta.y, screen_delta.x) / max(length(screen_delta), 0.0001);
        out.position.x = out.position.x + perpendicular.x * (local.uv_b.x * 2.0 - 1.0) * timing.z * out.position.w / view.viewport.z;
        out.position.y = out.position.y + perpendicular.y * (local.uv_b.x * 2.0 - 1.0) * timing.z * out.position.w / view.viewport.w;
    }
    out.uv = local.uv;
    @if(VERTEX_UVS_B)
    out.uv_b = local.uv_b;
    @if(VERTEX_OUTPUT_INSTANCE_INDEX)
    out.instance_index = source.instance_index;
    return out;
}

@fragment
fn fragment(in: VertexOutput) -> @location(0) vec4<f32> {
    let phase = cycle();
    let scan = min(phase * 2.8 / 2.2, 1.0);
    let scanning = select(0.0, 1.0, phase < 2.2 / 2.8);
    // Derivatives must be evaluated in uniform control flow: WebGPU rejects `fwidth`/`dpdx`
    // inside divergent branches (the volume-outline branch below), which invalidates the whole
    // pipeline and takes the canvas down. Sample once here and reuse.
    let edge_pixel = max(max(fwidth(in.uv_b.x), fwidth(in.uv_b.y)), 1.0e-5);
    var alpha = 0.0;
    if in.uv.y < 0.5 {
        let trail = fract(phase - in.uv.x + 1.0);
        alpha = select(0.0, 0.65 * (1.0 - smoothstep(0.08, 0.26, trail)), trail < 0.26);
    } else if in.uv.y < 1.5 {
        alpha = 0.45 * (1.0 - smoothstep(0.02, 0.12, abs(in.uv.x - scan))) * scanning;
    } else if in.uv.y < 2.5 {
        let trail = fract(phase - in.uv.x + 1.0);
        alpha = 0.35 * smoothstep(0.8, 1.0, scan) * scanning * (1.0 - smoothstep(0.08, 0.26, trail));
    } else {
        let edge_distance = min(min(in.uv_b.x, 1.0 - in.uv_b.x), min(in.uv_b.y, 1.0 - in.uv_b.y));
        let edge = 1.0 - smoothstep(edge_pixel, edge_pixel * 2.0, edge_distance);
        alpha = mix(0.10 * sin(scan * 3.14159265), 0.45, edge) * scanning;
    }
    let enter = smoothstep(0.0, 0.12, elapsed(globals.time, timing.x));
    let exit = select(1.0, 1.0 - smoothstep(0.0, 0.18, elapsed(globals.time, timing.y)), timing.y >= 0.0);
    return vec4(color.rgb, alpha * enter * exit);
}
