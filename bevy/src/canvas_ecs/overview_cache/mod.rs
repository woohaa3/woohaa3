//! CPU side overview-cache policy and lifecycle.
//!
//! GPU images and render passes are owned by the renderer resources. This module keeps the
//! deterministic owner state, dependency fingerprint and reservation accounting so late GPU
//! feedback cannot revive an old scene or leak a preview slot.

use std::collections::HashMap;

pub(crate) mod eligibility;
pub(crate) mod geometry;
pub(crate) mod subject;
#[cfg(feature = "canvas-core")]
pub(crate) mod gpu;
#[cfg(feature = "canvas-core")]
pub(crate) mod dispatch;
#[cfg(feature = "canvas-core")]
pub(crate) mod wire;
#[cfg(feature = "canvas-core")]
pub(crate) mod input;

/// Source layers requested by overview rendering, merged with shot-preview layers.
#[cfg(feature = "canvas-core")]
#[derive(bevy::prelude::Resource, Default)]
pub(crate) struct OverviewSourceLayers {
    pub(crate) owners: HashMap<String, OverviewSourceLayer>,
}

#[cfg(feature = "canvas-core")]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct OverviewSourceLayer {
    pub(crate) layer: Option<usize>,
    pub(crate) cached: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OverviewCacheState {
    Direct,
    Queued,
    Rendering,
    Cached,
    Suspended,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct OverviewCacheToken {
    pub(crate) epoch: u64,
    pub(crate) owner: u64,
    pub(crate) generation: u64,
    pub(crate) slot_generation: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OverviewCacheInput {
    pub(crate) local_placement: [u32; 7],
    pub(crate) media_revision: u64,
    pub(crate) geometry_revision: u64,
    pub(crate) layout_revision: u64,
    pub(crate) theme_revision: u64,
    pub(crate) quality: u8,
    pub(crate) tier: u16,
}

impl OverviewCacheInput {
    pub(crate) fn fingerprint(&self) -> u64 {
        let mut hash = 0xcbf29ce484222325u64;
        for value in self.local_placement.iter().copied().chain([
            self.media_revision as u32,
            (self.media_revision >> 32) as u32,
            self.geometry_revision as u32,
            (self.geometry_revision >> 32) as u32,
            self.layout_revision as u32,
            (self.layout_revision >> 32) as u32,
            self.theme_revision as u32,
            (self.theme_revision >> 32) as u32,
            self.quality as u32,
            self.tier as u32,
        ]) {
            hash ^= value as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
        hash
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct OverviewReservation {
    pub(crate) color_bytes: u64,
    pub(crate) attachment_bytes: u64,
    pub(crate) preview_slots: u32,
    settled: bool,
}

impl OverviewReservation {
    pub(crate) fn new(color_bytes: u64, attachment_bytes: u64, preview_slots: u32) -> Self {
        Self { color_bytes, attachment_bytes, preview_slots, settled: false }
    }
    pub(crate) fn total_bytes(self) -> u64 {
        self.color_bytes.saturating_add(self.attachment_bytes)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct OverviewBudget {
    pub(crate) bytes: u64,
    pub(crate) byte_limit: u64,
    pub(crate) slots: u32,
    pub(crate) slot_limit: u32,
}

impl OverviewBudget {
    pub(crate) fn reserve(&mut self, reservation: OverviewReservation) -> bool {
        if self.bytes.saturating_add(reservation.total_bytes()) > self.byte_limit
            || self.slots.saturating_add(reservation.preview_slots) > self.slot_limit
        {
            return false;
        }
        self.bytes += reservation.total_bytes();
        self.slots += reservation.preview_slots;
        true
    }

    pub(crate) fn release(&mut self, reservation: OverviewReservation) {
        self.bytes = self.bytes.saturating_sub(reservation.total_bytes());
        self.slots = self.slots.saturating_sub(reservation.preview_slots);
    }
}

#[derive(bevy::prelude::Resource, Default)]
pub(crate) struct OverviewCacheRegistry {
    entries: HashMap<u64, Entry>,
    draining: HashMap<OverviewCacheToken, OverviewReservation>,
    pub(crate) budget: OverviewBudget,
    pub(crate) diagnostics: OverviewCacheDiagnostics,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct OverviewCacheDiagnostics {
    pub(crate) queued: u64,
    pub(crate) hits: u64,
    pub(crate) refreshes: u64,
    pub(crate) failures: u64,
    pub(crate) fallbacks: u64,
    pub(crate) active_views: u32,
}

struct Entry {
    token: OverviewCacheToken,
    input: u64,
    state: OverviewCacheState,
    reservation: OverviewReservation,
    displayed: Option<OverviewReservation>,
}

impl OverviewCacheRegistry {
    pub(crate) fn has_pending(&self) -> bool {
        !self.draining.is_empty() || self.entries.values().any(|entry| matches!(entry.state, OverviewCacheState::Queued | OverviewCacheState::Rendering))
    }
    pub(crate) fn state(&self, owner: u64) -> OverviewCacheState {
        self.entries
            .get(&owner)
            .map_or(OverviewCacheState::Direct, |entry| entry.state)
    }

    pub(crate) fn request(
        &mut self,
        owner: u64,
        token: OverviewCacheToken,
        input: &OverviewCacheInput,
        reservation: OverviewReservation,
    ) -> bool {
        let fingerprint = input.fingerprint();
        if let Some(entry) = self.entries.get(&owner) {
            if entry.input == fingerprint
                && matches!(
                    entry.state,
                    OverviewCacheState::Queued
                        | OverviewCacheState::Rendering
                        | OverviewCacheState::Cached
                )
            {
                if entry.state == OverviewCacheState::Cached {
                    self.diagnostics.hits = self.diagnostics.hits.saturating_add(1);
                }
                return true;
            }
        }
        self.diagnostics.queued = self.diagnostics.queued.saturating_add(1);
        let mut displayed = None;
        if let Some(previous) = self.entries.remove(&owner) {
            displayed = previous.displayed;
            if previous.state == OverviewCacheState::Rendering {
                self.draining.insert(previous.token, previous.reservation);
            } else {
                self.budget.release(previous.reservation);
            }
        }
        if !self.budget.reserve(reservation) {
            self.diagnostics.fallbacks = self.diagnostics.fallbacks.saturating_add(1);
            self.entries.insert(
                owner,
                Entry {
                    token,
                    input: fingerprint,
                    state: OverviewCacheState::Suspended,
                    reservation: OverviewReservation::default(),
                    displayed,
                },
            );
            return false;
        }
        self.entries.insert(
            owner,
            Entry {
                token,
                input: fingerprint,
                state: OverviewCacheState::Queued,
                reservation,
                displayed,
            },
        );
        true
    }

    pub(crate) fn begin(&mut self, owner: u64, token: OverviewCacheToken) -> bool {
        let Some(entry) = self.entries.get_mut(&owner) else {
            return false;
        };
        if entry.token != token || entry.state != OverviewCacheState::Queued {
            return false;
        }
        entry.state = OverviewCacheState::Rendering;
        true
    }

    pub(crate) fn complete(
        &mut self,
        owner: u64,
        token: OverviewCacheToken,
        input: &OverviewCacheInput,
    ) -> bool {
        if self.settle_draining(token) {
            return false;
        }
        let Some(entry) = self.entries.get_mut(&owner) else {
            return false;
        };
        if entry.token != token
            || entry.state != OverviewCacheState::Rendering
            || entry.input != input.fingerprint()
        {
            return false;
        }
        entry.state = OverviewCacheState::Cached;
        if let Some(old) = entry.displayed.take() {
            self.budget.release(old);
        }
        let pending = std::mem::take(&mut entry.reservation);
        self.budget.release(OverviewReservation {
            attachment_bytes: pending.attachment_bytes,
            preview_slots: pending.preview_slots,
            ..Default::default()
        });
        entry.displayed = Some(OverviewReservation {
            color_bytes: pending.color_bytes,
            ..Default::default()
        });
        self.diagnostics.refreshes = self.diagnostics.refreshes.saturating_add(1);
        true
    }

    pub(crate) fn cancel(&mut self, owner: u64, token: OverviewCacheToken) -> bool {
        let Some(entry) = self.entries.get(&owner) else {
            return false;
        };
        if entry.token != token {
            return false;
        }
        let entry = self.entries.remove(&owner).expect("entry exists");
        if let Some(displayed) = entry.displayed {
            self.budget.release(displayed);
        }
        if entry.state == OverviewCacheState::Rendering {
            self.draining.insert(entry.token, entry.reservation);
        } else {
            self.budget.release(entry.reservation);
        }
        true
    }

    pub(crate) fn settle_draining(&mut self, token: OverviewCacheToken) -> bool {
        let Some(reservation) = self.draining.remove(&token) else {
            return false;
        };
        self.budget.release(reservation);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(media_revision: u64) -> OverviewCacheInput {
        OverviewCacheInput {
            local_placement: [1, 2, 3, 4, 5, 6, 7],
            media_revision,
            geometry_revision: 1,
            layout_revision: 1,
            theme_revision: 1,
            quality: 1,
            tier: 512,
        }
    }
    fn token(generation: u64) -> OverviewCacheToken {
        OverviewCacheToken {
            epoch: 1,
            owner: 7,
            generation,
            slot_generation: generation,
        }
    }

    #[test]
    fn identical_input_is_stable_and_late_feedback_is_rejected() {
        let mut registry = OverviewCacheRegistry {
            budget: OverviewBudget {
                byte_limit: 1000,
                slot_limit: 1,
                ..Default::default()
            },
            ..Default::default()
        };
        let reservation = OverviewReservation {
            color_bytes: 100,
            attachment_bytes: 50,
            preview_slots: 1,
            ..Default::default()
        };
        let first = input(1);
        assert!(registry.request(7, token(1), &first, reservation));
        assert!(registry.begin(7, token(1)));
        assert!(!registry.complete(7, token(1), &input(2)));
        assert!(registry.complete(7, token(1), &first));
        assert_eq!(registry.state(7), OverviewCacheState::Cached);
        assert!(!registry.begin(7, token(0)));
    }

    #[test]
    fn budget_and_cancel_are_idempotent() {
        let mut registry = OverviewCacheRegistry {
            budget: OverviewBudget {
                byte_limit: 100,
                slot_limit: 1,
                ..Default::default()
            },
            ..Default::default()
        };
        let reservation = OverviewReservation {
            color_bytes: 80,
            attachment_bytes: 20,
            preview_slots: 1,
            ..Default::default()
        };
        assert!(registry.request(1, token(1), &input(1), reservation));
        assert!(!registry.request(2, token(1), &input(1), reservation));
        assert!(registry.cancel(1, token(1)));
        assert!(!registry.cancel(1, token(1)));
        assert_eq!(
            registry.budget,
            OverviewBudget {
                bytes: 0,
                byte_limit: 100,
                slots: 0,
                slot_limit: 1
            }
        );
    }

    #[test]
    fn cancelled_render_keeps_budget_until_terminal_feedback() {
        let mut registry = OverviewCacheRegistry {
            budget: OverviewBudget {
                byte_limit: 100,
                slot_limit: 1,
                ..Default::default()
            },
            ..Default::default()
        };
        let reservation = OverviewReservation {
            color_bytes: 80,
            attachment_bytes: 20,
            preview_slots: 1,
            ..Default::default()
        };
        assert!(registry.request(7, token(1), &input(1), reservation));
        assert!(registry.begin(7, token(1)));
        assert!(registry.cancel(7, token(1)));
        assert_eq!(registry.budget.bytes, 100);
        assert!(!registry.request(7, token(2), &input(2), reservation));
        assert!(!registry.complete(7, token(1), &input(1)));
        assert_eq!(registry.budget.bytes, 0);
        assert!(!registry.settle_draining(token(1)));
    }

    #[test]
    fn refresh_accounts_for_displayed_and_pending_and_releases_attachments() {
        let mut registry = OverviewCacheRegistry {
            budget: OverviewBudget {
                byte_limit: 250,
                slot_limit: 1,
                ..Default::default()
            },
            ..Default::default()
        };
        let reservation = OverviewReservation {
            color_bytes: 100,
            attachment_bytes: 50,
            preview_slots: 1,
            ..Default::default()
        };
        assert!(registry.request(7, token(1), &input(1), reservation));
        assert!(registry.begin(7, token(1)));
        assert!(registry.complete(7, token(1), &input(1)));
        assert_eq!((registry.budget.bytes, registry.budget.slots), (100, 0));
        assert!(registry.request(7, token(2), &input(2), reservation));
        assert_eq!((registry.budget.bytes, registry.budget.slots), (250, 1));
        assert!(registry.begin(7, token(2)));
        assert!(registry.complete(7, token(2), &input(2)));
        assert_eq!((registry.budget.bytes, registry.budget.slots), (100, 0));
        assert!(registry.cancel(7, token(2)));
        assert_eq!((registry.budget.bytes, registry.budget.slots), (0, 0));
    }

    #[test]
    fn revisions_use_all_bits() {
        let original = input(1);
        let mut changed = original.clone();
        changed.geometry_revision += 1_u64 << 32;
        assert_ne!(original.fingerprint(), changed.fingerprint());
        changed = original.clone();
        changed.layout_revision += 1_u64 << 32;
        assert_ne!(original.fingerprint(), changed.fingerprint());
        changed = original.clone();
        changed.theme_revision += 1_u64 << 32;
        assert_ne!(original.fingerprint(), changed.fingerprint());
    }

    #[test]
    fn repeated_identical_requests_preserve_the_inflight_token() {
        let mut registry = OverviewCacheRegistry {
            budget: OverviewBudget {
                byte_limit: 1000,
                slot_limit: 1,
                ..Default::default()
            },
            ..Default::default()
        };
        let reservation = OverviewReservation {
            color_bytes: 100,
            attachment_bytes: 50,
            preview_slots: 1,
            ..Default::default()
        };
        assert!(registry.request(7, token(1), &input(1), reservation));
        assert!(registry.has_pending());
        assert!(registry.begin(7, token(1)));
        assert!(registry.request(7, token(2), &input(1), reservation));
        assert_eq!((registry.budget.bytes, registry.budget.slots), (150, 1));
        assert!(registry.complete(7, token(1), &input(1)));
        assert!(!registry.has_pending());
        assert_eq!(registry.diagnostics.queued, 1);
    }
}
