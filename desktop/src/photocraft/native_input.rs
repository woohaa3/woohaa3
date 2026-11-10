use woohaa_desktop_host::document_editor::*;
fn modifiers(m: InputModifiers) -> egui::Modifiers {
    egui::Modifiers {
        alt: m.alt,
        ctrl: m.control,
        shift: m.shift,
        mac_cmd: m.meta,
        command: if cfg!(target_os = "macos") {
            m.meta
        } else {
            m.control
        },
    }
}
fn pos(p: [f64; 2]) -> egui::Pos2 {
    egui::pos2(p[0] as f32, p[1] as f32)
}
pub fn raw(context: &EditorFrameContext) -> egui::RawInput {
    let mut raw = egui::RawInput {
        time: Some(context.time_seconds),
        focused: true,
        ..Default::default()
    };
    for input in &context.input {
        if input.layout_generation != context.layout_generation {
            continue;
        }
        match &input.event {
            NativeInputEvent::Pointer {
                phase,
                pointer_id,
                pointer_type,
                pressure,
                position_css,
                button,
                modifiers: m,
                samples,
                ..
            } => {
                raw.events
                    .push(egui::Event::ModifiersChanged(modifiers(*m)));
                for sample in samples {
                    if pointer_type != "mouse" {
                        raw.events.push(egui::Event::Touch {
                            device_id: egui::TouchDeviceId(1),
                            id: egui::TouchId(*pointer_id),
                            phase: egui::TouchPhase::Move,
                            pos: pos(sample.position_css),
                            force: Some(sample.pressure),
                        });
                    }
                    raw.events
                        .push(egui::Event::PointerMoved(pos(sample.position_css)));
                }
                raw.events
                    .push(egui::Event::PointerMoved(pos(*position_css)));
                if pointer_type != "mouse" {
                    raw.events.push(egui::Event::Touch {
                        device_id: egui::TouchDeviceId(1),
                        id: egui::TouchId(*pointer_id),
                        phase: match phase {
                            PointerPhase::Down => egui::TouchPhase::Start,
                            PointerPhase::Move => egui::TouchPhase::Move,
                            PointerPhase::Up => egui::TouchPhase::End,
                            PointerPhase::Cancel => egui::TouchPhase::Cancel,
                        },
                        pos: pos(*position_css),
                        force: Some(*pressure),
                    });
                }
                let button = match button {
                    1 => egui::PointerButton::Middle,
                    2 => egui::PointerButton::Secondary,
                    3 => egui::PointerButton::Extra1,
                    4 => egui::PointerButton::Extra2,
                    _ => egui::PointerButton::Primary,
                };
                match phase {
                    PointerPhase::Down | PointerPhase::Up => {
                        raw.events.push(egui::Event::PointerButton {
                            pos: pos(*position_css),
                            button,
                            pressed: *phase == PointerPhase::Down,
                            modifiers: modifiers(*m),
                        })
                    }
                    PointerPhase::Cancel => {
                        raw.events.push(egui::Event::PointerButton {
                            pos: pos(*position_css),
                            button,
                            pressed: false,
                            modifiers: modifiers(*m),
                        });
                        raw.events.push(egui::Event::PointerGone);
                    }
                    PointerPhase::Move => {}
                }
            }
            NativeInputEvent::Zoom {
                position_css,
                factor,
            } => {
                raw.events
                    .push(egui::Event::PointerMoved(pos(*position_css)));
                raw.events.push(egui::Event::Zoom(*factor as f32));
                // Numeric only, at most one consumption report per second.
                static LOG: std::sync::Mutex<Option<std::time::Instant>> =
                    std::sync::Mutex::new(None);
                if let Ok(mut last) = LOG.try_lock() {
                    let now = std::time::Instant::now();
                    if last.is_none_or(|previous| now.duration_since(previous).as_secs() >= 1) {
                        eprintln!(
                            "[photocraft-native] zoom consumed sequence={} factor={} layout={}",
                            input.sequence, factor, input.layout_generation
                        );
                        *last = Some(now);
                    }
                }
            }
            NativeInputEvent::Wheel {
                position_css,
                delta_css,
                modifiers: m,
            } => {
                raw.events
                    .push(egui::Event::ModifiersChanged(modifiers(*m)));
                raw.events
                    .push(egui::Event::PointerMoved(pos(*position_css)));
                raw.events.push(egui::Event::MouseWheel {
                    unit: egui::MouseWheelUnit::Point,
                    phase: egui::TouchPhase::Move,
                    delta: egui::vec2(-delta_css[0] as f32, -delta_css[1] as f32),
                    modifiers: modifiers(*m),
                });
            }
            NativeInputEvent::Key {
                key,
                pressed,
                repeat,
                modifiers: m,
                ..
            } => {
                raw.events
                    .push(egui::Event::ModifiersChanged(modifiers(*m)));
                if let Some(k) = egui::Key::from_name(key) {
                    raw.events.push(egui::Event::Key {
                        key: k,
                        physical_key: Some(k),
                        pressed: *pressed,
                        repeat: *repeat,
                        modifiers: modifiers(*m),
                    });
                }
                if *pressed && !m.control && !m.meta && key.chars().count() == 1 {
                    raw.events.push(egui::Event::Text(key.clone()));
                }
            }
            NativeInputEvent::ImePreedit { text, selection } => {
                raw.events.push(egui::Event::Ime(egui::ImeEvent::Preedit {
                    text: text.clone(),
                    active_range_chars: selection.map(|[a, b]| a..b),
                }))
            }
            NativeInputEvent::ImeCommit { text } => raw
                .events
                .push(egui::Event::Ime(egui::ImeEvent::Commit(text.clone()))),
            NativeInputEvent::Blur => {
                raw.focused = false;
                raw.events.push(egui::Event::WindowFocused(false));
                raw.events.push(egui::Event::PointerGone);
            }
        }
    }
    raw
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn zoom_is_incremental_anchored_and_not_scroll() {
        let context = EditorFrameContext {
            physical_size: [800, 600],
            scale_factor: 2.0,
            time_seconds: 1.0,
            layout_generation: 3,
            viewport_origin_css: [0.0, 0.0],
            input: vec![NativeEditorInput {
                sequence: 1,
                layout_generation: 3,
                time_seconds: 1.0,
                event: NativeInputEvent::Zoom {
                    position_css: [40.0, 50.0],
                    factor: 1.25,
                },
            }],
        };
        let raw = raw(&context);
        assert!(
            matches!(raw.events.as_slice(), [egui::Event::PointerMoved(p), egui::Event::Zoom(f)] if *p == egui::pos2(40.0,50.0) && *f == 1.25)
        );
        let ctx = egui::Context::default();
        let mut output = ctx.run_ui(raw, |ui| {
            ui.input(|i| {
                assert_eq!(i.zoom_delta(), 1.25);
                assert_eq!(i.smooth_scroll_delta, egui::Vec2::ZERO);
            });
        });
        output.textures_delta.clear();
    }
}
