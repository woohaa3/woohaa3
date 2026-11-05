#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    woohaa_desktop_host::desktop_entry::run(Vec::new());
}
