//! Append a trace command after Bevy's unmodified DrawSprite command tuple.
//! It runs only if pipeline binding, texture binding and draw_indexed succeeded.
use super::video_diagnostics::{Snapshot, log};
use bevy::{
    core_pipeline::core_2d::Transparent2d,
    ecs::{
        query::ROQueryItem,
        system::{
            SystemParamItem,
            lifetimeless::{Read, SRes},
        },
    },
    prelude::*,
    render::{
        Render, RenderSystems,
        render_phase::{
            AddRenderCommand, DrawFunctions, RenderCommand, RenderCommandResult, TrackedRenderPass,
            ViewSortedRenderPhases,
        },
        view::ExtractedView,
    },
    sprite_render::{DrawSprite, ExtractedSprites, SpriteBatches},
};
use serde_json::json;

type TracedSprite = (DrawSprite, TraceIssued);
pub(super) fn install(app: &mut SubApp) {
    app.add_render_command::<Transparent2d, TracedSprite>()
        .add_systems(
            Render,
            arm.after(RenderSystems::PrepareBindGroups)
                .before(RenderSystems::Render),
        );
}
fn arm(
    snapshot: Res<Snapshot>,
    functions: Res<DrawFunctions<Transparent2d>>,
    mut phases: ResMut<ViewSortedRenderPhases<Transparent2d>>,
    mut armed: Local<bool>,
) {
    if snapshot.rows.is_empty() && !*armed {
        return;
    }
    *armed = !snapshot.rows.is_empty();
    let functions = functions.read();
    let original = functions.id::<DrawSprite>();
    let traced = functions.id::<TracedSprite>();
    for phase in phases.values_mut() {
        for item in phase.items.values_mut() {
            // Cached phase entries must return to the original command between samples.
            if item.draw_function == original || item.draw_function == traced {
                item.draw_function = if snapshot.rows.is_empty() {
                    original
                } else {
                    traced
                };
            }
        }
    }
}
struct TraceIssued;
impl RenderCommand<Transparent2d> for TraceIssued {
    type Param = (
        SRes<Snapshot>,
        SRes<ExtractedSprites>,
        SRes<SpriteBatches>,
        SRes<ViewSortedRenderPhases<Transparent2d>>,
    );
    type ViewQuery = Read<ExtractedView>;
    type ItemQuery = ();
    fn render<'w>(
        item: &Transparent2d,
        view: ROQueryItem<'w, '_, Self::ViewQuery>,
        _: Option<()>,
        (snapshot, sprites, batches, phases): SystemParamItem<'w, '_, Self::Param>,
        _: &mut TrackedRenderPass<'w>,
    ) -> RenderCommandResult {
        let sprites = sprites.into_inner();
        let Some(leader) = sprites
            .sprites
            .iter()
            .find(|s| s.render_entity == item.entity.0)
        else {
            return RenderCommandResult::Success;
        };
        for (entity, row) in &snapshot.into_inner().rows {
            let phase = phases.get(&view.retained_view_entity);
            let belongs = sprites.sprites.iter().any(|s| {
                if s.main_entity != *entity || s.image_handle_id != leader.image_handle_id {
                    return false;
                }
                let mut in_batch = false;
                phase.is_some_and(|phase| {
                    phase.items.values().any(|p| {
                        if p.entity == item.entity {
                            in_batch = true;
                        } else if !p.batch_range.is_empty() {
                            in_batch = false;
                        }
                        in_batch && p.entity.0 == s.render_entity
                    })
                })
            });
            if !belongs {
                continue;
            }
            let mut row = row.clone();
            row["stage"] = json!("gpu-draw-issued");
            row["view"] = json!(format!("{:?}", view.retained_view_entity));
            row["batch"] = json!(
                batches
                    .get(&(view.retained_view_entity, item.entity.0))
                    .map(|b| format!("{b:?}"))
            );
            row["drawImage"] = json!(format!("{:?}", leader.image_handle_id));
            log(row);
        }
        RenderCommandResult::Success
    }
}
