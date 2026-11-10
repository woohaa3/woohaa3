#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(feature = "native-ui")]
mod photocraft;

fn main() {
    #[cfg(feature = "native-ui")]
    let factories: Vec<
        std::sync::Arc<dyn woohaa_desktop_host::document_editor::NativeDocumentEditorFactory>,
    > = vec![std::sync::Arc::new(photocraft::desktop::PhotoCraftFactory)];
    #[cfg(not(feature = "native-ui"))]
    let factories = Vec::new();

    woohaa_desktop_host::desktop_entry::run(factories);
}
