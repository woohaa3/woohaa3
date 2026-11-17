//! Build-time representation choice for reproducible batching comparisons.
//! This is renderer configuration, never modelScript or canonical scene data.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(super) enum BatchStrategy {
    Automatic,
    Spatial,
    #[cfg(feature = "explicit-instancing")]
    Explicit,
}
impl Default for BatchStrategy {
    fn default() -> Self {
        match option_env!("WOOHAA_STATIC_BATCH_STRATEGY") {
            None | Some("spatial") => Self::Spatial,
            Some("automatic") => Self::Automatic,
            #[cfg(feature = "explicit-instancing")]
            Some("explicit") => Self::Explicit,
            Some(_) => panic!("WOOHAA_STATIC_BATCH_STRATEGY must be automatic or spatial"),
        }
    }
}
impl BatchStrategy {
    pub fn name(self) -> &'static str {
        match self {
            Self::Automatic => "bevy-automatic",
            Self::Spatial => "spatial-merge",
            #[cfg(feature = "explicit-instancing")]
            Self::Explicit => "explicit-instancing",
        }
    }
    pub fn merges(self) -> bool {
        self != Self::Automatic
    }
}
