//! Explicitly armed, bounded benchmark samples; disabled in normal use.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Sample {
    pub at_ms: f64,
    pub generation: u32,
}
#[derive(Default)]
pub(crate) struct Samples {
    enabled: bool,
    rows: Vec<Sample>,
    dropped: usize,
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disabled_and_rearming() {
        let mut s = Samples::default();
        s.push(1.0, 7);
        assert_eq!(s.drain().0.len(), 0);
        s.arm(true);
        s.push(2.0, 8);
        let (rows, lost) = s.drain();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].generation, 8);
        assert_eq!(rows[0].at_ms, 2.0);
        assert_eq!(lost, 0);
        s.push(3.0, 9);
        s.arm(false);
        assert_eq!(s.drain().0.len(), 0);
    }
    #[test]
    fn overflow_is_explicit_and_drain_clears() {
        let mut s = Samples::default();
        s.arm(true);
        for i in 0..16_390 { s.push(i as f64, 1); }
        let (rows, dropped) = s.drain();
        assert_eq!(rows.len(), 16_384);
        assert_eq!(dropped, 6);
        assert!(s.drain().0.is_empty());
        assert_eq!(s.drain().1, 0);
    }
}

impl Samples {
    pub fn arm(&mut self, enabled: bool) {
        self.enabled = enabled;
        self.rows.clear();
        self.dropped = 0;
    }
    pub fn enabled(&self) -> bool { self.enabled }
    pub fn push(&mut self, at_ms: f64, generation: u32) {
        if !self.enabled { return; }
        if self.rows.len() < 16_384 { self.rows.push(Sample { at_ms, generation }); }
        else { self.dropped += 1; }
    }
    pub fn drain(&mut self) -> (Vec<Sample>, usize) {
        (std::mem::take(&mut self.rows), std::mem::take(&mut self.dropped))
    }
}
