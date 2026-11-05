//! Native editor GPU leases. Publication and retirement never wait on the GPU.
use bevy::render::{
    render_resource::{
        Extent3d, Texture, TextureDescriptor, TextureDimension, TextureFormat, TextureUsages,
    },
    renderer::RenderDevice,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LeaseError {
    Busy,
    Stale,
    InvalidState,
    InvalidSize,
    BudgetExceeded,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WriteTicket {
    pub device_generation: u64,
    pub frame: u64,
    pub revision: u64,
    pub slot: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Slot {
    Free,
    Writing(WriteTicket),
    Pending(WriteTicket, u64),
    Ready(WriteTicket, u64),
    Front(WriteTicket, u64),
    Retiring(u64),
}

/// Submission numbers are monotonically assigned by the single queue owner.
/// Completion callbacks may arrive late; they never publish a newer generation's old frame.
pub struct DoubleBufferState {
    generation: u64,
    slots: [Slot; 2],
    front: Option<usize>,
    last_frame: u64,
    completed: u64,
}

impl DoubleBufferState {
    pub fn new(generation: u64) -> Self {
        Self {
            generation,
            slots: [Slot::Free; 2],
            front: None,
            last_frame: 0,
            completed: 0,
        }
    }
    pub fn begin(
        &mut self,
        generation: u64,
        frame: u64,
        revision: u64,
    ) -> Result<WriteTicket, LeaseError> {
        if generation != self.generation || frame <= self.last_frame {
            return Err(LeaseError::Stale);
        }
        if self.slots.iter().any(|s| {
            matches!(
                s,
                Slot::Writing(_) | Slot::Pending(_, _) | Slot::Ready(_, _)
            )
        }) {
            return Err(LeaseError::Busy);
        }
        let slot = self
            .slots
            .iter()
            .position(|s| *s == Slot::Free)
            .ok_or(LeaseError::Busy)?;
        let ticket = WriteTicket {
            device_generation: generation,
            frame,
            revision,
            slot,
        };
        self.slots[slot] = Slot::Writing(ticket);
        self.last_frame = frame;
        Ok(ticket)
    }
    fn slot_mut(&mut self, ticket: WriteTicket) -> Result<&mut Slot, LeaseError> {
        if ticket.device_generation != self.generation {
            return Err(LeaseError::Stale);
        }
        self.slots.get_mut(ticket.slot).ok_or(LeaseError::Stale)
    }
    pub fn submitted(&mut self, ticket: WriteTicket, submission: u64) -> Result<(), LeaseError> {
        let completed = self.completed;
        if submission <= completed {
            return Err(LeaseError::InvalidState);
        }
        let slot = self.slot_mut(ticket)?;
        if *slot != Slot::Writing(ticket) {
            return Err(LeaseError::InvalidState);
        }
        *slot = Slot::Pending(ticket, submission);
        Ok(())
    }
    /// Caller invokes only after error scope succeeded and write submission completed.
    pub fn validated(&mut self, ticket: WriteTicket) -> Result<(), LeaseError> {
        let completed = self.completed;
        let slot = self.slot_mut(ticket)?;
        let Slot::Pending(current, submission) = *slot else {
            return Err(LeaseError::InvalidState);
        };
        if current != ticket || submission > completed {
            return Err(LeaseError::InvalidState);
        }
        *slot = Slot::Ready(ticket, submission);
        Ok(())
    }
    pub fn publish(&mut self, ticket: WriteTicket) -> Result<(), LeaseError> {
        let slot = self.slot_mut(ticket)?;
        let Slot::Ready(current, submission) = *slot else {
            return Err(LeaseError::InvalidState);
        };
        if current != ticket {
            return Err(LeaseError::Stale);
        }
        if let Some(previous) = self.front {
            if let Slot::Front(_, last_read) = self.slots[previous] {
                self.slots[previous] = if last_read <= self.completed {
                    Slot::Free
                } else {
                    Slot::Retiring(last_read)
                };
            }
        }
        self.slots[ticket.slot] = Slot::Front(ticket, submission);
        self.front = Some(ticket.slot);
        Ok(())
    }
    pub fn mark_read(&mut self, submission: u64) -> Result<(), LeaseError> {
        let Some(slot) = self.front else {
            return Err(LeaseError::InvalidState);
        };
        let Slot::Front(ticket, previous) = self.slots[slot] else {
            return Err(LeaseError::InvalidState);
        };
        if submission < previous {
            return Err(LeaseError::Stale);
        }
        self.slots[slot] = Slot::Front(ticket, submission);
        Ok(())
    }
    pub fn complete(&mut self, generation: u64, submission: u64) -> Result<(), LeaseError> {
        if generation != self.generation {
            return Err(LeaseError::Stale);
        }
        self.completed = self.completed.max(submission);
        for slot in &mut self.slots {
            if matches!(*slot, Slot::Retiring(last) if last <= self.completed) {
                *slot = Slot::Free;
            }
        }
        Ok(())
    }
    pub fn failed(&mut self, ticket: WriteTicket) -> Result<(), LeaseError> {
        let completed = self.completed;
        let slot = self.slot_mut(ticket)?;
        *slot = match *slot {
            Slot::Writing(current) if current == ticket => Slot::Free,
            Slot::Pending(current, submission) | Slot::Ready(current, submission)
                if current == ticket =>
            {
                if submission <= completed {
                    Slot::Free
                } else {
                    Slot::Retiring(submission)
                }
            }
            _ => return Err(LeaseError::InvalidState),
        };
        Ok(())
    }
    pub fn front(&self) -> Option<WriteTicket> {
        self.front.and_then(|slot| match self.slots[slot] {
            Slot::Front(ticket, _) => Some(ticket),
            _ => None,
        })
    }
    pub fn invalidate(&mut self, generation: u64) -> Result<(), LeaseError> {
        if generation <= self.generation {
            return Err(LeaseError::Stale);
        }
        self.generation = generation;
        self.front = None;
        self.slots = [Slot::Free; 2];
        self.last_frame = 0;
        self.completed = 0;
        Ok(())
    }
}

/// Both textures are allocated by the Bevy device. No pixel buffers or second device exist here.
pub struct SharedDocumentTextures {
    textures: [Texture; 2],
    state: DoubleBufferState,
    pub width: u32,
    pub height: u32,
    pub format: TextureFormat,
}

impl SharedDocumentTextures {
    pub fn allocate(
        device: &RenderDevice,
        generation: u64,
        width: u32,
        height: u32,
        budget_bytes: u64,
    ) -> Result<Self, LeaseError> {
        if width == 0
            || height == 0
            || width > device.limits().max_texture_dimension_2d
            || height > device.limits().max_texture_dimension_2d
        {
            return Err(LeaseError::InvalidSize);
        }
        let bytes = u64::from(width)
            .checked_mul(u64::from(height))
            .and_then(|n| n.checked_mul(8))
            .ok_or(LeaseError::BudgetExceeded)?;
        if bytes > budget_bytes {
            return Err(LeaseError::BudgetExceeded);
        }
        let format = TextureFormat::Rgba8UnormSrgb;
        let create = || {
            device.create_texture(&TextureDescriptor {
                label: Some("document-editor-view"),
                size: Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: TextureDimension::D2,
                format,
                usage: TextureUsages::COPY_DST
                    | TextureUsages::COPY_SRC
                    | TextureUsages::TEXTURE_BINDING
                    | TextureUsages::RENDER_ATTACHMENT,
                view_formats: &[],
            })
        };
        Ok(Self {
            textures: [create(), create()],
            state: DoubleBufferState::new(generation),
            width,
            height,
            format,
        })
    }
    pub fn writable(&self, ticket: WriteTicket) -> Result<&Texture, LeaseError> {
        if ticket.device_generation != self.state.generation {
            return Err(LeaseError::Stale);
        }
        if self.state.slots.get(ticket.slot) != Some(&Slot::Writing(ticket)) {
            return Err(LeaseError::InvalidState);
        }
        self.textures.get(ticket.slot).ok_or(LeaseError::Stale)
    }
    pub fn begin(
        &mut self,
        generation: u64,
        frame: u64,
        revision: u64,
    ) -> Result<WriteTicket, LeaseError> {
        self.state.begin(generation, frame, revision)
    }
    pub fn submitted(&mut self, ticket: WriteTicket, submission: u64) -> Result<(), LeaseError> {
        self.state.submitted(ticket, submission)
    }
    pub fn complete(&mut self, generation: u64, submission: u64) -> Result<(), LeaseError> {
        self.state.complete(generation, submission)
    }
    pub fn validated(&mut self, ticket: WriteTicket) -> Result<(), LeaseError> {
        self.state.validated(ticket)
    }
    pub fn publish(&mut self, ticket: WriteTicket) -> Result<(), LeaseError> {
        self.state.publish(ticket)
    }
    pub fn failed(&mut self, ticket: WriteTicket) -> Result<(), LeaseError> {
        self.state.failed(ticket)
    }
    pub fn mark_read(&mut self, submission: u64) -> Result<(), LeaseError> {
        self.state.mark_read(submission)
    }
    pub fn front(&self) -> Option<&Texture> {
        self.state.front().and_then(|t| self.textures.get(t.slot))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ready(s: &mut DoubleBufferState, frame: u64, submission: u64) -> WriteTicket {
        let t = s.begin(1, frame, frame).unwrap();
        s.submitted(t, submission).unwrap();
        s.complete(1, submission).unwrap();
        s.validated(t).unwrap();
        t
    }
    #[test]
    fn publication_waits_for_validation_and_retirement_waits_for_readers() {
        let mut s = DoubleBufferState::new(1);
        let a = ready(&mut s, 1, 1);
        s.publish(a).unwrap();
        let b = s.begin(1, 2, 2).unwrap();
        s.submitted(b, 2).unwrap();
        s.mark_read(3).unwrap();
        s.complete(1, 2).unwrap();
        s.validated(b).unwrap();
        s.publish(b).unwrap();
        assert_eq!(s.front(), Some(b));
        assert_eq!(s.begin(1, 3, 3), Err(LeaseError::Busy));
        s.complete(1, 3).unwrap();
        assert!(s.begin(1, 3, 3).is_ok());
    }
    #[test]
    fn failed_submission_preserves_front_and_never_reuses_inflight_slot() {
        let mut s = DoubleBufferState::new(1);
        let a = ready(&mut s, 1, 1);
        s.publish(a).unwrap();
        let b = s.begin(1, 2, 2).unwrap();
        s.submitted(b, 2).unwrap();
        assert_eq!(s.validated(b), Err(LeaseError::InvalidState));
        s.failed(b).unwrap();
        assert_eq!(s.front(), Some(a));
        assert_eq!(s.begin(1, 3, 3), Err(LeaseError::Busy));
        s.complete(1, 2).unwrap();
        assert!(s.begin(1, 3, 3).is_ok());
    }
    #[test]
    fn device_generation_rejects_old_callbacks() {
        let mut s = DoubleBufferState::new(1);
        let a = s.begin(1, 1, 1).unwrap();
        s.invalidate(2).unwrap();
        assert_eq!(s.submitted(a, 1), Err(LeaseError::Stale));
        assert!(s.front().is_none());
        let next = s.begin(2, 1, 1).unwrap();
        s.submitted(next, 1).unwrap();
        assert_eq!(s.complete(1, 100), Err(LeaseError::Stale));
        assert_eq!(s.validated(next), Err(LeaseError::InvalidState));
        s.complete(2, 1).unwrap();
        s.validated(next).unwrap();
    }
}
