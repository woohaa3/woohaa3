//! Explicit user-authorized native dialogs and background file I/O for the official UI.
use photocraft_ui_egui::{
    Services,
    file_dialog::{FileDialogAnswer, FileDialogRequest},
};
use std::sync::Arc;
fn wait<F: std::future::Future>(future: F) -> F::Output {
    struct Wake(std::thread::Thread);
    impl std::task::Wake for Wake {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
    }
    let waker = std::task::Waker::from(Arc::new(Wake(std::thread::current())));
    let mut cx = std::task::Context::from_waker(&waker);
    let mut f = std::pin::pin!(future);
    loop {
        match f.as_mut().poll(&mut cx) {
            std::task::Poll::Ready(r) => return r,
            std::task::Poll::Pending => std::thread::park(),
        }
    }
}
fn atomic_write(path: &str, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let path = std::path::Path::new(path);
    let parent = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.error.to_string())?;
    Ok(())
}
pub fn native() -> Services {
    Services {
        import: Some(Box::new(|name, bytes, options| {
            photocraft_io::import_with_options(name, bytes, options)
                .map(|r| (r.document, r.warnings))
                .map_err(|e| e.to_string())
        })),
        export: Some(Box::new(|doc, path, settings| {
            photocraft_io::export(doc, path, &settings.io_options())
                .map(|r| (r.bytes, r.warnings))
                .map_err(|e| e.to_string())
        })),
        write: Some(Box::new(atomic_write)),
        save_file: Some(Arc::new(|doc, path, settings, ctl| {
            let pixels = u64::from(doc.size.width) * u64::from(doc.size.height);
            if pixels > 40_000_000 {
                return Err("Export exceeds native working-memory budget".into());
            }
            ctl.check()?;
            ctl.progress(0., "Encoding");
            let cancel = || ctl.check().is_err();
            let progress = |n| ctl.progress(n * 0.9, "Encoding");
            let interrupt = photocraft_raster::Interrupt::new(&cancel, &progress);
            let result = photocraft_io::export_with(doc, path, &settings.io_options(), &interrupt)
                .map_err(|e| e.to_string())?;
            if result.bytes.len() > 256 * 1024 * 1024 {
                return Err("Export exceeds byte budget".into());
            }
            ctl.commit()?;
            ctl.progress(0.9, "Writing");
            atomic_write(path, &result.bytes)?;
            ctl.progress(1., "");
            Ok(result.warnings)
        })),
        file_dialog: Some(Box::new(|request, _parent, reply| {
            // Dialog futures marshal to the platform UI; waiting/reading is off the owner thread.
            let dialog = rfd::AsyncFileDialog::new();
            std::thread::spawn(move || {
                let answer = match request {
                    FileDialogRequest::Open {
                        multiple,
                        initial_dir,
                        extensions,
                    } => {
                        let dialog = if let Some(dir) = initial_dir {
                            dialog.set_directory(dir)
                        } else {
                            dialog
                        };
                        let extensions = extensions.unwrap_or_else(|| {
                            vec![
                                "png".into(),
                                "jpg".into(),
                                "jpeg".into(),
                                "webp".into(),
                                "pcraft".into(),
                                "psd".into(),
                                "tif".into(),
                            ]
                        });
                        let dialog = dialog.add_filter("Supported Files", &extensions);
                        if multiple {
                            wait(dialog.pick_files()).map(|files| {
                                FileDialogAnswer::Paths(
                                    files
                                        .into_iter()
                                        .map(|f| f.path().to_string_lossy().into_owned())
                                        .collect(),
                                )
                            })
                        } else {
                            wait(dialog.pick_file()).map(|file| {
                                FileDialogAnswer::Paths(vec![
                                    file.path().to_string_lossy().into_owned(),
                                ])
                            })
                        }
                    }
                    FileDialogRequest::Folder { initial_dir } => {
                        let dialog = if let Some(dir) = initial_dir {
                            dialog.set_directory(dir)
                        } else {
                            dialog
                        };
                        wait(dialog.pick_folder()).map(|f| {
                            FileDialogAnswer::FolderTo(f.path().to_string_lossy().into_owned())
                        })
                    }
                    FileDialogRequest::Save { suggested } => {
                        let path = std::path::Path::new(&suggested);
                        let dialog = if let Some(name) = path.file_name() {
                            dialog.set_file_name(name.to_string_lossy())
                        } else {
                            dialog
                        };
                        let dialog = if let Some(parent) =
                            path.parent().filter(|p| !p.as_os_str().is_empty())
                        {
                            dialog.set_directory(parent)
                        } else {
                            dialog
                        };
                        wait(dialog.save_file()).map(|f| {
                            FileDialogAnswer::SaveTo(f.path().to_string_lossy().into_owned())
                        })
                    }
                };
                reply.send(answer);
            });
        })),
        file_stamp: Some(Box::new(|path| {
            std::fs::metadata(path)
                .ok()
                .map(|m| photocraft_ui_egui::FileStamp {
                    len: m.len(),
                    modified: m.modified().ok(),
                })
        })),
        same_file: Some(Box::new(|a, b| {
            std::path::Path::new(a) == std::path::Path::new(b)
        })),
        ..Default::default()
    }
}
