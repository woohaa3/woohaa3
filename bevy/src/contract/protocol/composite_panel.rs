//! Public, business-neutral container surface for managed composite children.
use serde::Deserialize;

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CompositeContainerPanel {
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) message: String,
    #[serde(default)]
    pub(crate) hint: String,
    #[serde(default)]
    pub(crate) image_ids: Vec<String>,
}
impl CompositeContainerPanel {
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        let mut seen = std::collections::HashSet::new();
        if self.title.len() > 4096
            || self.message.len() > 8192
            || self.hint.len() > 8192
            || self.image_ids.len() > 8
            || self
                .image_ids
                .iter()
                .any(|id| id.is_empty() || id.len() > 1024 || !seen.insert(id))
        {
            return Err("Invalid composite container panel");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn composite_panel_validates_surface_and_thumbnail_limits() {
        let valid = json!({"title":"References","imageIds":["a","b"]});
        assert!(
            serde_json::from_value::<CompositeContainerPanel>(valid.clone())
                .unwrap()
                .validate()
                .is_ok()
        );
        for ids in [
            json!([""]),
            json!(["a", "a"]),
            json!((0..9).map(|n| n.to_string()).collect::<Vec<_>>()),
        ] {
            let mut panel = valid.clone();
            panel["imageIds"] = ids;
            assert!(
                serde_json::from_value::<CompositeContainerPanel>(panel)
                    .unwrap()
                    .validate()
                    .is_err()
            );
        }
        let mut panel = valid;
        panel["html"] = json!("<div />");
        assert!(serde_json::from_value::<CompositeContainerPanel>(panel).is_err());
    }
    #[test]
    fn composite_panel_requires_v25_renderer() {
        let mut scene = json!({"version":super::super::CANVAS_RENDER_SCENE_VERSION,"nodes":[],"edges":[],
            "theme":serde_json::from_str::<serde_json::Value>(&super::super::tests::theme_object()).unwrap()});
        assert!(
            serde_json::from_value::<super::super::Scene>(scene.clone())
                .unwrap()
                .validate()
                .is_ok()
        );
        scene["version"] = json!("woohaa-canvas-render-scene-v24");
        assert!(
            serde_json::from_value::<super::super::Scene>(scene)
                .unwrap()
                .validate()
                .is_err()
        );
    }
}
