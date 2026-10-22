//! CPU start budget: bounded admission between indivisible texture/camera updates.
use bevy::platform::time::Instant;

pub(super) struct StartBudget {
    since: Instant,
    starts: usize,
}
impl StartBudget {
    pub fn new() -> Self {
        Self {
            since: Instant::now(),
            starts: 0,
        }
    }
    pub fn permits(&self) -> bool {
        permits(self.starts, self.since.elapsed().as_secs_f64() * 1000.0)
    }
    pub fn started(&mut self) {
        self.starts += 1;
    }
}
fn permits(starts: usize, elapsed_ms: f64) -> bool {
    starts < 2 && (starts == 0 || elapsed_ms < 2.0)
}
/// Interactive work leads initially; after eight frames a deferred static view
/// competes by original age. Replacing its generation does not reset that age.
pub(super) fn priority(interactive: bool, age: Option<u64>, tick: u64) -> (bool, u64) {
    let aged = age.is_some_and(|since| tick.saturating_sub(since) >= 8);
    (!(interactive || aged), age.unwrap_or(tick))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn at_least_one_start_progresses_but_count_and_elapsed_bound_followups() {
        assert!(permits(0, 100.));
        assert!(permits(1, 1.9));
        assert!(!permits(1, 2.));
        assert!(!permits(2, 0.));
    }
    #[test]
    fn aged_static_work_competes_before_new_interactive_work() {
        assert!(priority(false, Some(0), 8) < priority(true, Some(7), 8));
        assert!(priority(true, None, 1) < priority(false, Some(0), 1));
    }
}
