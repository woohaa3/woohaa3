@group(2) @binding(0) var image: texture_2d<f32>;
@group(2) @binding(1) var image_sampler: sampler;
@group(2) @binding(2) var<uniform> backdrop: vec4<f32>;
// Official egui output is premultiplied sRGB in an unorm texture. Convert the
// unassociated color to linear, then premultiply for Bevy's linear compositor.
@fragment fn fragment(@location(2) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let pixel = textureSample(image, image_sampler, uv);
    if pixel.a <= 0.00001 { return backdrop; }
    let color = clamp(pixel.rgb / pixel.a, vec3(0.0), vec3(1.0));
    let linear = select(pow((color + 0.055) / 1.055, vec3(2.4)), color / 12.92, color <= vec3(0.04045));
    return vec4(linear * pixel.a, pixel.a) + backdrop * (1.0 - pixel.a);
}
