//! Frameless window actions. Called only after the native boundary authenticates
//! the main WebView, and only on the Tauri main thread.
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum Action {
    State,
    Drag,
    Minimize,
    ToggleMaximize,
    Close,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    action: Action,
}

fn parse(body: &[u8]) -> Result<Action, String> {
    if body.len() > 256 {
        return Err("Window request exceeds budget".into());
    }
    serde_json::from_slice::<Request>(body)
        .map(|request| request.action)
        .map_err(|error| error.to_string())
}

pub fn control(window: &tauri::WebviewWindow, body: &[u8]) -> Result<Value, String> {
    let action = parse(body)?;
    let maximized = window.is_maximized().map_err(|error| error.to_string())?;
    let result = match action {
        Action::State => Ok(()),
        Action::Drag => window.start_dragging(),
        Action::Minimize => window.minimize(),
        Action::ToggleMaximize if maximized => window.unmaximize(),
        Action::ToggleMaximize => window.maximize(),
        Action::Close => window.close(),
    };
    result.map_err(|error| error.to_string())?;
    Ok(json!({"maximized": if action == Action::ToggleMaximize { !maximized } else { maximized }}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_boundary_accepts_only_explicit_actions() {
        assert_eq!(parse(br#"{"action":"toggle-maximize"}"#).unwrap(), Action::ToggleMaximize);
        assert_eq!(parse(br#"{"action":"drag"}"#).unwrap(), Action::Drag);
        assert!(parse(br#"{"action":"execute"}"#).is_err());
        assert!(parse(br#"{"action":"close","window":"other"}"#).is_err());
        assert!(parse(br#"{"method":"close"}"#).is_err());
        assert!(parse(&[b' '; 257]).is_err());
    }
}
