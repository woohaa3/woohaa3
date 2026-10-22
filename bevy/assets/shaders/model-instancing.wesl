import bevy_pbr::render::{
    mesh_functions,
    forward_io::{Vertex, VertexOutput, decompress_vertex},
    view_transformations::position_world_to_clip,
};

@vertex
fn vertex(
    source: Vertex,
    @location(8) local_x: vec4<f32>,
    @location(9) local_y: vec4<f32>,
    @location(10) local_z: vec4<f32>,
    @location(11) normal_x: vec4<f32>,
    @location(12) normal_y: vec4<f32>,
    @location(13) normal_z: vec4<f32>,
    @location(14) root_index_value: f32,
) -> VertexOutput {
    let root_index = u32(root_index_value);
    let vertex = decompress_vertex(source, root_index);
    let root = mesh_functions::get_world_from_local(root_index);
    let local_position = vec4(vertex.position, 1.0);
    let local = vec3(dot(local_x, local_position), dot(local_y, local_position), dot(local_z, local_position));
    let local_normal = vec3(dot(normal_x.xyz, vertex.normal), dot(normal_y.xyz, vertex.normal), dot(normal_z.xyz, vertex.normal));
    var out: VertexOutput;
    out.world_position = root * vec4(local, 1.0);
    out.position = position_world_to_clip(out.world_position.xyz);
    out.world_normal = mesh_functions::mesh_normal_local_to_world(local_normal, root_index);
    @if(VERTEX_UVS_A)
    out.uv = vertex.uv;
    @if(VERTEX_UVS_B)
    out.uv_b = vertex.uv_b;
    @if(VERTEX_OUTPUT_INSTANCE_INDEX)
    out.instance_index = root_index;
    return out;
}
