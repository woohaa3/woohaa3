//! Test-only observation channel for the node-action bar producer.
//!
//! The producer keeps its retained state in a `Local`, which a test cannot reach after a schedule
//! run. Tests that need to prove "only the moved bar was redrawn" read this counter instead.

#[cfg(test)]
use std::cell::Cell;

#[cfg(test)]
thread_local! {
    static LAST: Cell<(usize, bool)> = const { Cell::new((0, false)) };
}

#[cfg(test)]
pub(crate) fn record(rows: usize, whole: bool) {
    LAST.with(|last| last.set((rows, whole)));
}

/// `(rows, whole)` of the last bar producer run.
#[cfg(test)]
pub(crate) fn last() -> (usize, bool) {
    LAST.with(Cell::get)
}

#[cfg(test)]
mod tests {
    #[test]
    fn records_the_last_run() {
        super::record(2, false);
        assert_eq!(super::last(), (2, false));
        super::record(0, true);
        assert_eq!(super::last(), (0, true));
    }
}
