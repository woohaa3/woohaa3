//! Bounded owner-thread input. Coordinates remain CSS points until the consumer
//! explicitly requests physical coordinates; DPR is applied exactly once.
use super::{EditorError, ErrorCode};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, VecDeque};
pub const MAX_INPUT_EVENTS: usize = 256;
pub const MAX_MOVE_SAMPLES: usize = 64;
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct InputModifiers {
    pub alt: bool,
    pub control: bool,
    pub shift: bool,
    pub meta: bool,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PointerPhase {
    Down,
    Move,
    Up,
    Cancel,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PointerSample {
    pub position_css: [f64; 2],
    pub pressure: f32,
    pub time_seconds: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum NativeInputEvent {
    Pointer {
        phase: PointerPhase,
        pointer_id: u64,
        #[serde(default = "mouse_pointer_type")]
        pointer_type: String,
        position_css: [f64; 2],
        pressure: f32,
        button: u8,
        buttons: u16,
        modifiers: InputModifiers,
        samples: Vec<PointerSample>,
    },
    Zoom {
        position_css: [f64; 2],
        factor: f64,
    },
    Wheel {
        position_css: [f64; 2],
        delta_css: [f64; 2],
        modifiers: InputModifiers,
    },
    Key {
        key: String,
        code: String,
        pressed: bool,
        repeat: bool,
        modifiers: InputModifiers,
    },
    ImePreedit {
        text: String,
        selection: Option<[usize; 2]>,
    },
    ImeCommit {
        text: String,
    },
    Blur,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeEditorInput {
    pub sequence: u64,
    pub layout_generation: u64,
    pub time_seconds: f64,
    pub event: NativeInputEvent,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditorLayout {
    pub physical_size: [u32; 2],
    pub scale_factor: f64,
    pub layout_generation: u64,
    pub viewport_origin_css: [f64; 2],
}
impl EditorLayout {
    pub fn validate(&self) -> Result<(), EditorError> {
        if self.layout_generation == 0
            || self.physical_size.iter().any(|&n| n == 0 || n > 32768)
            || !self.scale_factor.is_finite()
            || self.scale_factor <= 0.0
            || self.scale_factor > 8.0
            || !finite(self.viewport_origin_css)
        {
            return Err(EditorError::new(
                ErrorCode::BudgetExceeded,
                "invalid editor layout",
            ));
        }
        Ok(())
    }
    pub fn physical_position(&self, local_css: [f64; 2]) -> Result<[f64; 2], EditorError> {
        self.validate()?;
        if !finite(local_css) {
            return Err(EditorError::new(
                ErrorCode::Unsupported,
                "invalid pointer coordinates",
            ));
        }
        Ok(local_css.map(|n| n * self.scale_factor))
    }
    pub fn window_css_to_local(&self, window_css: [f64; 2]) -> [f64; 2] {
        [
            window_css[0] - self.viewport_origin_css[0],
            window_css[1] - self.viewport_origin_css[1],
        ]
    }
}
fn mouse_pointer_type() -> String {
    "mouse".into()
}
fn finite(p: [f64; 2]) -> bool {
    p.iter().all(|n| n.is_finite() && n.abs() <= 1e9)
}
impl NativeEditorInput {
    pub fn validate(&self) -> Result<(), EditorError> {
        let valid = self.sequence > 0
            && self.time_seconds.is_finite()
            && match &self.event {
                NativeInputEvent::Pointer {
                    position_css,
                    pressure,
                    pointer_type,
                    button,
                    samples,
                    ..
                } => {
                    matches!(pointer_type.as_str(), "mouse" | "pen" | "touch")
                        && finite(*position_css)
                        && pressure.is_finite()
                        && (0.0..=1.0).contains(pressure)
                        && *button <= 4
                        && samples.len() <= MAX_MOVE_SAMPLES
                        && samples.iter().all(|p| {
                            finite(p.position_css)
                                && p.pressure.is_finite()
                                && (0.0..=1.0).contains(&p.pressure)
                                && p.time_seconds.is_finite()
                        })
                }
                NativeInputEvent::Zoom {
                    position_css,
                    factor,
                } => finite(*position_css) && factor.is_finite() && (0.01..=100.0).contains(factor),
                NativeInputEvent::Wheel {
                    position_css,
                    delta_css,
                    ..
                } => finite(*position_css) && finite(*delta_css),
                NativeInputEvent::Key { key, code, .. } => key.len() <= 128 && code.len() <= 128,
                NativeInputEvent::ImePreedit { text, selection } => {
                    text.len() <= 16384
                        && selection.is_none_or(|[a, b]| a <= b && b <= text.chars().count())
                }
                NativeInputEvent::ImeCommit { text } => text.len() <= 16384,
                NativeInputEvent::Blur => true,
            };
        if valid {
            Ok(())
        } else {
            Err(EditorError::new(
                ErrorCode::BudgetExceeded,
                "invalid or oversized editor input",
            ))
        }
    }
}
#[derive(Default)]
pub struct EditorInputQueue {
    queue: VecDeque<NativeEditorInput>,
    layout_generation: u64,
    last_sequence: u64,
    pressed: BTreeSet<u64>,
}
impl EditorInputQueue {
    pub fn set_layout(&mut self, layout_generation: u64) {
        if self.layout_generation != layout_generation {
            self.cancel_all();
            self.layout_generation = layout_generation;
            for event in &mut self.queue {
                event.layout_generation = layout_generation;
            }
        }
    }
    pub fn enqueue(&mut self, input: NativeEditorInput) -> Result<(), EditorError> {
        input.validate()?;
        if self.layout_generation == 0 {
            return Err(EditorError::new(
                ErrorCode::StaleGeneration,
                "input layout is not bound",
            ));
        }
        if input.layout_generation != self.layout_generation || input.sequence <= self.last_sequence
        {
            return Err(EditorError::new(
                ErrorCode::StaleGeneration,
                "input sequence or layout differs",
            ));
        }
        self.last_sequence = input.sequence;
        if matches!(input.event, NativeInputEvent::Blur) {
            self.cancel_all();
            return Ok(());
        }
        if let NativeInputEvent::Pointer {
            phase: PointerPhase::Move,
            pointer_id,
            position_css,
            pressure,
            samples,
            ..
        } = &input.event
        {
            if let Some(last) = self.queue.back_mut() {
                let old_time = last.time_seconds;
                if let NativeInputEvent::Pointer {
                    phase: PointerPhase::Move,
                    pointer_id: old_id,
                    samples: old_samples,
                    position_css: old_position,
                    pressure: old_pressure,
                    ..
                } = &mut last.event
                {
                    if old_id == pointer_id {
                        let mut merged = std::mem::take(old_samples);
                        if merged.is_empty() {
                            merged.push(PointerSample {
                                position_css: *old_position,
                                pressure: *old_pressure,
                                time_seconds: old_time,
                            });
                        }
                        if samples.is_empty() {
                            merged.push(PointerSample {
                                position_css: *position_css,
                                pressure: *pressure,
                                time_seconds: input.time_seconds,
                            });
                        } else {
                            merged.extend(samples.clone());
                        }
                        if merged.len() > MAX_MOVE_SAMPLES {
                            let count = merged.len();
                            merged = (0..MAX_MOVE_SAMPLES)
                                .map(|i| merged[i * (count - 1) / (MAX_MOVE_SAMPLES - 1)].clone())
                                .collect();
                        }
                        let mut next = input;
                        if let NativeInputEvent::Pointer { samples, .. } = &mut next.event {
                            *samples = merged;
                        }
                        *last = next;
                        return Ok(());
                    }
                }
            }
        }
        if self.queue.len() >= MAX_INPUT_EVENTS {
            self.cancel_all();
            return Err(EditorError::new(
                ErrorCode::Busy,
                "input overflow cancelled the current gesture",
            ));
        }
        if let NativeInputEvent::Pointer {
            phase, pointer_id, ..
        } = &input.event
        {
            match phase {
                PointerPhase::Down => {
                    if self.pressed.len() >= 16 && !self.pressed.contains(pointer_id) {
                        self.cancel_all();
                        return Err(EditorError::new(
                            ErrorCode::Busy,
                            "too many active pointers",
                        ));
                    }
                    self.pressed.insert(*pointer_id);
                }
                PointerPhase::Up | PointerPhase::Cancel => {
                    self.pressed.remove(pointer_id);
                }
                _ => {}
            }
        }
        self.queue.push_back(input);
        Ok(())
    }
    /// Blur is an explicit release-all contract, including keyboard/IME. It replaces
    /// an overflowing gesture with cancellation instead of silently losing its up.
    pub fn cancel_all(&mut self) {
        self.queue.clear();
        self.pressed.clear();
        self.queue.push_back(NativeEditorInput {
            sequence: self.last_sequence,
            layout_generation: self.layout_generation,
            time_seconds: 0.0,
            event: NativeInputEvent::Blur,
        });
    }
    pub fn drain(&mut self) -> Vec<NativeEditorInput> {
        self.queue.drain(..).collect()
    }
    pub fn len(&self) -> usize {
        self.queue.len()
    }
    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }
}
/// Hit test in CSS coordinates. Page chrome is supplied first; native UI comes
/// before the document and the ordinary scene. Each event has exactly one owner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputOwner {
    Page,
    NativeUi,
    Document,
    Scene,
}
pub fn route_pointer(
    point: [f64; 2],
    page: &[[f64; 4]],
    ui: &[[f64; 4]],
    document: Option<[f64; 4]>,
) -> InputOwner {
    let inside = |rect: &[f64; 4]| {
        point[0] >= rect[0]
            && point[1] >= rect[1]
            && point[0] < rect[0] + rect[2]
            && point[1] < rect[1] + rect[3]
    };
    if page.iter().any(inside) {
        InputOwner::Page
    } else if ui.iter().any(inside) {
        InputOwner::NativeUi
    } else if document.is_some_and(|r| inside(&r)) {
        InputOwner::Document
    } else {
        InputOwner::Scene
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn event(sequence: u64, phase: PointerPhase) -> NativeEditorInput {
        NativeEditorInput {
            sequence,
            layout_generation: 1,
            time_seconds: sequence as f64,
            event: NativeInputEvent::Pointer {
                phase,
                pointer_id: 1,
                pointer_type: "mouse".into(),
                position_css: [sequence as f64, 2.0],
                pressure: 0.5,
                button: 0,
                buttons: 1,
                modifiers: InputModifiers::default(),
                samples: vec![],
            },
        }
    }
    #[test]
    fn zoom_factor_is_bounded_and_survives_queue_without_coalescing() {
        let mut q = EditorInputQueue::default();
        q.set_layout(1);
        q.drain();
        for (i, factor) in [1.2, 1.25].into_iter().enumerate() {
            let mut input = event(i as u64 + 1, PointerPhase::Move);
            input.event = NativeInputEvent::Zoom {
                position_css: [4.0, 5.0],
                factor,
            };
            q.enqueue(input).unwrap();
        }
        assert_eq!(q.drain().len(), 2);
        for factor in [0.0, -1.0, f64::NAN, f64::INFINITY, 101.0] {
            let mut input = event(3, PointerPhase::Move);
            input.event = NativeInputEvent::Zoom {
                position_css: [4.0, 5.0],
                factor,
            };
            assert!(input.validate().is_err());
        }
    }
    #[test]
    fn points_convert_once_and_route_one_owner() {
        let l = EditorLayout {
            physical_size: [200, 100],
            scale_factor: 2.0,
            layout_generation: 1,
            viewport_origin_css: [10.0, 20.0],
        };
        assert_eq!(
            l.physical_position(l.window_css_to_local([15.0, 24.0]))
                .unwrap(),
            [10.0, 8.0]
        );
        assert_eq!(
            route_pointer(
                [5.0, 5.0],
                &[[0.0, 0.0, 10.0, 10.0]],
                &[[0.0, 0.0, 20.0, 20.0]],
                Some([0.0, 0.0, 30.0, 30.0])
            ),
            InputOwner::Page
        );
    }
    #[test]
    fn routing_priorities_are_exclusive_for_all_regions() {
        for (x, owner) in [
            (5.0, InputOwner::Page),
            (15.0, InputOwner::NativeUi),
            (25.0, InputOwner::Document),
            (35.0, InputOwner::Scene),
        ] {
            assert_eq!(
                route_pointer(
                    [x, 5.0],
                    &[[0.0, 0.0, 10.0, 10.0]],
                    &[[0.0, 0.0, 20.0, 10.0]],
                    Some([0.0, 0.0, 30.0, 10.0])
                ),
                owner
            );
        }
        let mut queue = EditorInputQueue::default();
        assert_eq!(
            queue
                .enqueue(event(1, PointerPhase::Down))
                .unwrap_err()
                .code,
            ErrorCode::StaleGeneration
        );
    }
    #[test]
    fn move_coalescing_is_bounded_and_preserves_up() {
        let mut q = EditorInputQueue::default();
        q.set_layout(1);
        q.drain();
        q.enqueue(event(1, PointerPhase::Down)).unwrap();
        for n in 2..200 {
            q.enqueue(event(n, PointerPhase::Move)).unwrap();
        }
        q.enqueue(event(200, PointerPhase::Up)).unwrap();
        let events = q.drain();
        assert_eq!(events.len(), 3);
        if let NativeInputEvent::Pointer { samples, .. } = &events[1].event {
            assert!(samples.len() <= 64);
            assert_eq!(samples.first().unwrap().position_css[0], 2.0);
            assert_eq!(samples.last().unwrap().position_css[0], 199.0);
        }
        assert!(matches!(
            events[2].event,
            NativeInputEvent::Pointer {
                phase: PointerPhase::Up,
                ..
            }
        ));
    }
    #[test]
    fn overflow_cancels_instead_of_sticking_pointer_and_layout_rejects_old_events() {
        let mut q = EditorInputQueue::default();
        q.set_layout(1);
        q.drain();
        for n in 1..=256 {
            q.enqueue(event(n, PointerPhase::Down)).unwrap();
        }
        assert_eq!(
            q.enqueue(event(257, PointerPhase::Up)).unwrap_err().code,
            ErrorCode::Busy
        );
        let events = q.drain();
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0].event, NativeInputEvent::Blur));
        q.set_layout(2);
        assert_eq!(
            q.enqueue(event(258, PointerPhase::Move)).unwrap_err().code,
            ErrorCode::StaleGeneration
        );
    }
}
