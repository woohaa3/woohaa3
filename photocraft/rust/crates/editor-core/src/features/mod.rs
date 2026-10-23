//! Static domain contributions; versions, stage delivery and global budgets stay integration-owned.
#[derive(Clone, Copy)]
pub struct StagedId { pub stage: &'static str, pub order: usize, pub id: &'static str }
pub struct FeatureContribution {
    pub id: &'static str,
    pub capabilities: &'static [StagedId],
    pub commands: &'static [StagedId],
}
pub mod files;
pub mod io;
pub mod vectors;
pub mod selections;
pub mod channels;
pub mod painting;
pub mod retouch;
pub mod adjustments;
pub mod modes;
pub mod filters;
pub mod composition;
pub mod layers;
pub mod smart;
pub mod r#type;
pub mod views;
pub mod customization;
pub mod history;
pub mod animation;

pub const FEATURES: &[&FeatureContribution] = &[
    &files::CONTRIBUTION,
    &io::CONTRIBUTION,
    &vectors::CONTRIBUTION,
    &selections::CONTRIBUTION,
    &channels::CONTRIBUTION,
    &painting::CONTRIBUTION,
    &retouch::CONTRIBUTION,
    &adjustments::CONTRIBUTION,
    &modes::CONTRIBUTION,
    &filters::CONTRIBUTION,
    &composition::CONTRIBUTION,
    &layers::CONTRIBUTION,
    &smart::CONTRIBUTION,
    &r#type::CONTRIBUTION,
    &views::CONTRIBUTION,
    &customization::CONTRIBUTION,
    &history::CONTRIBUTION,
    &animation::CONTRIBUTION,
];
fn for_stage(stage: &str, entries: impl Iterator<Item = &'static StagedId>) -> Vec<&'static str> {
    let mut ids: Vec<_> = entries.filter(|entry| entry.stage == stage).collect();
    ids.sort_by_key(|entry| entry.order);
    ids.into_iter().map(|entry| entry.id).collect()
}
pub fn capabilities_for_stage(stage: &str) -> Vec<&'static str> {
    for_stage(stage, FEATURES.iter().flat_map(|feature| feature.capabilities))
}
pub fn commands_for_stage(stage: &str) -> Vec<&'static str> {
    for_stage(stage, FEATURES.iter().flat_map(|feature| feature.commands))
}
