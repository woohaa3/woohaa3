use super::*;

pub(super) fn layer_transform(layer: &Layer) -> Value {
    match &layer.content {
        LayerContent::Text(text) => {
            let [a, b, c, d, e, f] = text.transform.m;
            let scale = (a * a + b * b).sqrt();
            let rotation_degrees = b.atan2(a).to_degrees();
            let det = a * d - b * c;
            json!({
                "translateX": e,
                "translateY": f,
                "scale": if scale > 0.0 { scale } else { 1.0 },
                "rotationDegrees": rotation_degrees,
                "flipHorizontal": det < 0.0,
                "flipVertical": false
            })
        }
        LayerContent::Raster(surface) => {
            let bounds = surface.content_bounds();
            json!({
                "translateX": bounds.x0,
                "translateY": bounds.y0,
                "scale": 1.0,
                "rotationDegrees": 0.0,
                "flipHorizontal": false,
                "flipVertical": false
            })
        }
        _ => json!({
            "translateX": 0.0,
            "translateY": 0.0,
            "scale": 1.0,
            "rotationDegrees": 0.0,
            "flipHorizontal": false,
            "flipVertical": false
        }),
    }
}
