//! Small control-only bridge; GPU images never cross this boundary.
use std::{collections::VecDeque, sync::{Mutex, OnceLock}};
use serde::{Deserialize, Serialize};

const MAX_COMMANDS: usize = 256;

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Command {
    Render { owner: String, fingerprint: String, generation: u64, epoch: u64 },
    Cancel { owner: String, generation: u64, epoch: u64 },
    Release { owner: String, epoch: u64, generation: u64, #[serde(rename = "requestId")] request_id: u64 },
}

impl Command {
    fn valid(&self) -> bool {
        let (owner, epoch, generation) = match self {
            Self::Render { owner, epoch, generation, fingerprint } => {
                if fingerprint.len() != 16 || u64::from_str_radix(fingerprint, 16).is_err() { return false; }
                (owner, *epoch, *generation)
            }
            Self::Cancel { owner, epoch, generation } => (owner, *epoch, *generation),
            Self::Release { owner, epoch, generation, request_id } => {
                if *request_id == 0 || *request_id > 9_007_199_254_740_991 { return false; }
                (owner, *epoch, *generation)
            }
        };
        !owner.is_empty() && owner.len() <= 1024 && epoch > 0 && epoch <= 9_007_199_254_740_991
            && generation > 0 && generation <= 9_007_199_254_740_991
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Candidate {
    pub(crate) owner_id: String,
    pub(crate) fingerprint: String,
    pub(crate) tier: u32,
    pub(crate) bytes: u64,
    pub(crate) attachment_bytes: u64,
    pub(crate) eligible: bool,
    pub(crate) reason: Option<String>,
    pub(crate) model_declared: bool,
    pub(crate) model_ready: bool,
    pub(crate) media_declared: usize,
    pub(crate) media_ready: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResultEntry {
    pub(crate) owner: String,
    pub(crate) generation: u64,
    pub(crate) epoch: u64,
    pub(crate) success: bool,
    pub(crate) cancelled: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReleaseEntry {
    pub(crate) owner: String,
    pub(crate) epoch: u64,
    pub(crate) request_id: u64,
}

#[derive(Default, Serialize)]
pub(crate) struct Snapshot {
    pub(crate) candidates: Vec<Candidate>,
    pub(crate) results: Vec<ResultEntry>,
    pub(crate) releases: Vec<ReleaseEntry>,
}

static COMMANDS: OnceLock<Mutex<VecDeque<Command>>> = OnceLock::new();
static SNAPSHOT: OnceLock<Mutex<String>> = OnceLock::new();
#[cfg(test)]
pub(crate) static TEST_WIRE_LOCK: Mutex<()> = Mutex::new(());

fn commands() -> &'static Mutex<VecDeque<Command>> { COMMANDS.get_or_init(|| Mutex::new(VecDeque::new())) }
fn snapshot_slot() -> &'static Mutex<String> { SNAPSHOT.get_or_init(|| Mutex::new("{\"candidates\":[],\"results\":[],\"releases\":[]}".to_owned())) }

pub(crate) fn enqueue(json: &str) -> Result<(), &'static str> {
    if json.len() > 8192 { return Err("overview-command-too-large"); }
    let command: Command = serde_json::from_str(json).map_err(|_| "overview-command-invalid")?;
    if !command.valid() { return Err("overview-command-invalid"); }
    let mut commands = commands().lock().map_err(|_| "overview-command-unavailable")?;
    if commands.len() >= MAX_COMMANDS { return Err("overview-command-full"); }
    commands.push_back(command);
    Ok(())
}

pub(crate) fn take_commands() -> VecDeque<Command> {
    commands().lock().map(|mut commands| std::mem::take(&mut *commands)).unwrap_or_default()
}

pub(crate) fn set_snapshot(snapshot: &Snapshot) {
    if let Ok(json) = serde_json::to_string(snapshot) {
        if let Ok(mut slot) = snapshot_slot().lock() { *slot = json; }
    }
}

pub(crate) fn snapshot() -> String { snapshot_slot().lock().map(|slot| slot.clone()).unwrap_or_default() }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_control_messages() {
        let parse = |json| serde_json::from_str::<Command>(json).unwrap().valid();
        assert!(parse(r#"{"kind":"render","owner":"film","fingerprint":"0000000000000007","generation":2,"epoch":1}"#));
        assert!(parse(r#"{"kind":"cancel","owner":"film","generation":2,"epoch":1}"#));
        assert!(!parse(r#"{"kind":"render","owner":"film","fingerprint":"xyz","generation":2,"epoch":1}"#));
        assert!(!parse(r#"{"kind":"release","owner":"","epoch":1,"generation":1,"requestId":1}"#));
    }
}
