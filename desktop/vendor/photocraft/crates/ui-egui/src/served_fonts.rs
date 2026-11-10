//! Fonts a host serves next to the app, for the platform shell that fetches them (the web build;
//! see `photocraft_text::served`): reading the manifest, the families to fetch, and installing
//! what arrived, which registers the files and re-renders the type layers drawn without them.

use std::sync::{Arc, Mutex, PoisonError};

use photocraft_doc::{DocId, LayerContent, LayerId, TextLayer};
pub use photocraft_text::served::{ServedFont, add_families, add_fonts, is_relative_path, parse_manifest, request_for_languages, take_requests};

use crate::PhotocraftApp;

/// Layers whose document was busy with a background job when their font arrived.
static PENDING: Mutex<Vec<(DocId, LayerId)>> = Mutex::new(Vec::new());

/// Served script fallback fonts that arrived, kept as bytes: `Context::set_fonts` (a language or
/// theme change) replaces the whole UI stack and would otherwise drop them.
static UI_FALLBACKS: Mutex<Vec<(String, Arc<Vec<u8>>)>> = Mutex::new(Vec::new());

/// Name of a served family in the UI font stack.
fn ui_font_name(family: &str) -> String {
    format!("served-ui-{family}")
}

/// Registers delivered fonts that are a served script fallback as UI fallbacks: immediately, when
/// the font covers the interface language, and after every later UI font-stack rebuild.
/// Returns whether a family was stored for the first time.
pub fn install_ui_delivered(ctx: &egui::Context, delivered: &[(String, Vec<u8>)]) -> bool {
    let fallbacks = photocraft_text::served::script_fallback_families();
    let mut added = false;
    {
        let mut stored = UI_FALLBACKS.lock().unwrap_or_else(PoisonError::into_inner);
        for (family, bytes) in delivered {
            if fallbacks.contains(family) && !stored.iter().any(|(have, _)| have == family) {
                stored.push((family.clone(), Arc::new(bytes.clone())));
                added = true;
            }
        }
    }
    if added {
        install_ui_fonts(ctx);
    }
    added
}

/// Asks for every served family up front: the package ships these files, so load them whatever
/// the interface or document language is, instead of waiting for a language or a layout to ask.
pub fn request_all() {
    for family in photocraft_text::served::families() {
        photocraft_text::served::request(&family);
    }
}

/// Registers every stored served script fallback at the lowest priority in every UI family.
/// Call this when a font arrives; a stack rebuild uses [`add_ui_fonts_to`] instead.
pub fn install_ui_fonts(ctx: &egui::Context) {
    let stored: Vec<(String, Arc<Vec<u8>>)> = UI_FALLBACKS.lock().unwrap_or_else(PoisonError::into_inner).clone();
    for (family, bytes) in stored {
        crate::cjk_fonts::add_ui_fallback(ctx, ui_font_name(&family), bytes.as_ref().clone());
    }
}

/// Adds every stored served script fallback to `fonts` before `Context::set_fonts` installs it.
///
/// A rebuild cannot re-add them afterwards: `set_fonts` drops fonts added with `Context::add_font`
/// and `add_font` also skips a name the still-active (previous) stack already contains. Latin keeps
/// Inter because the face is appended last in every family.
pub(crate) fn add_ui_fonts_to(ctx: &egui::Context, fonts: &mut egui::FontDefinitions) {
    let stored: Vec<(String, Arc<Vec<u8>>)> = UI_FALLBACKS.lock().unwrap_or_else(PoisonError::into_inner).clone();
    for (family, bytes) in stored {
        let data = egui::FontData::from_owned(bytes.as_ref().clone());
        crate::cjk_fonts::add_to_definitions(ctx, fonts, ui_font_name(&family), data);
    }
}

/// Registers delivered font files (`(family, bytes)`, the family as the manifest lists it) and
/// re-renders the type layers that use those families, or whose text falls back to them (a script
/// fallback, e.g. Arabic set in Inter), and show our own layout. A PSD layer still
/// showing Photoshop's pixels (not edited yet) keeps them, as it does when its font is installed
/// from the start. Call it every frame: it also retries the layers of a document that was busy.
pub fn install(app: &mut PhotocraftApp, delivered: Vec<(String, Vec<u8>)>) {
    let mut layers = std::mem::take(&mut *PENDING.lock().unwrap_or_else(PoisonError::into_inner));
    if !delivered.is_empty() {
        let families: Vec<String> = delivered.iter().map(|(f, _)| f.clone()).collect();
        // Decided before the fonts are in: "shows our own layout" compares the layer's pixels
        // with what the engine draws now, that is with the fallback font.
        for st in app.session.documents() {
            for (_, _, l) in st.doc.walk() {
                if let LayerContent::Text(t) = &l.content
                    && redraws_for(t, &families)
                    && crate::type_tool::shows_own_layout(&st.doc, t)
                    && !layers.contains(&(st.doc.id, l.id))
                {
                    layers.push((st.doc.id, l.id));
                }
            }
        }
        let mut eng = photocraft_text::shared().lock().unwrap_or_else(PoisonError::into_inner);
        for (family, bytes) in delivered {
            let added = eng.fonts.register_font_data(bytes);
            if !added.contains(&family) {
                log::warn!("a served font file listed as {family:?} registers {added:?}; the family in fonts/manifest.txt must be the font's own");
            }
        }
    }
    if !layers.is_empty() {
        let busy = app.session.refresh_type_layers(&layers);
        PENDING.lock().unwrap_or_else(PoisonError::into_inner).extend(busy);
    }
}

/// Should the layer be redrawn when `families` arrive: it uses one of them, or its text is in a
/// script one of them is the served fallback for?
fn redraws_for(t: &TextLayer, families: &[String]) -> bool {
    uses_family(t, families) || families.iter().any(|f| photocraft_text::served::falls_back_to(&t.text, f))
}

/// Does the layer use one of `families`, by name or through the PostScript name a PSD gave?
fn uses_family(t: &TextLayer, families: &[String]) -> bool {
    t.char_runs().iter().any(|r| {
        families.contains(&r.style.font_family)
            || r.style.postscript_name.as_deref().is_some_and(|ps| families.contains(&photocraft_text::fonts::guess_from_postscript(ps).family))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_layer_uses_a_family_by_name_or_postscript_name() {
        let t = TextLayer { text: "Hi".into(), font_family: "Open Sans".into(), ..Default::default() };
        assert!(uses_family(&t, &["Open Sans".into()]));
        assert!(!uses_family(&t, &["Lato".into()]));
        let mut psd = TextLayer { text: "Hi".into(), font_family: "Inter".into(), ..Default::default() };
        psd.runs = vec![photocraft_doc::text::TextRun {
            len: 2,
            style: photocraft_doc::text::CharStyle { font_family: "Inter".into(), postscript_name: Some("Lato-Bold".into()), ..Default::default() },
        }];
        assert!(uses_family(&psd, &["Lato".into()]));
    }

    #[test]
    fn a_layer_in_a_script_redraws_when_that_scripts_fallback_arrives() {
        // Thai: other tests use other scripts (the served catalog is process-wide).
        let thai = "Served Test Thai";
        photocraft_text::served::add_fonts(&parse_manifest(&format!("{thai} | Regular | fonts/t/T.ttf | Thai\n")).0);
        let layer = |text: &str| TextLayer { text: text.into(), font_family: "Inter".into(), ..Default::default() };
        assert!(redraws_for(&layer("สวัสดี"), &[thai.into()]), "Thai text set in Inter falls back to it");
        assert!(!redraws_for(&layer("hello"), &[thai.into()]));
        assert!(redraws_for(&layer("hello"), &["Inter".into()]), "and a layer still redraws for its own family");
    }

    /// The real client font, or a file named by `PHOTOCRAFT_TEST_NOTOSANS`.
    fn noto_sans_sc() -> Option<Vec<u8>> {
        let path = std::env::var_os("PHOTOCRAFT_TEST_NOTOSANS").map(std::path::PathBuf::from).unwrap_or_else(|| {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../../web/frontend/public/assets/fonts/NotoSansSC-Regular.otf")
        });
        match std::fs::read(&path) {
            Ok(bytes) => Some(bytes),
            Err(e) => {
                eprintln!("skipping the served-font UI test: {}: {e}", path.display());
                None
            }
        }
    }

    fn has_chinese(ctx: &egui::Context) -> bool {
        // `set_fonts` and `add_font` land at the start of the next pass.
        for _ in 0..2 {
            ctx.run_ui(Default::default(), |_| {}).textures_delta.clear();
        }
        ctx.fonts_mut(|f| f.has_glyphs(&egui::FontId::proportional(12.0), "中文"))
    }

    /// D5/3.1/3.3: the host's Noto Sans SC reaches the UI as a lowest-priority fallback, and
    /// language changes plus a theme rebuild keep it (they all re-run `install_fonts`, which
    /// calls `Context::set_fonts`). Also proves egui rasterizes the CFF/OTF file.
    #[test]
    fn served_chinese_font_draws_the_ui_and_survives_stack_rebuilds() {
        let Some(bytes) = noto_sans_sc() else { return };
        let family = "Noto Sans SC";
        photocraft_text::served::add_fonts(&parse_manifest(&format!("{family} | Regular | fonts/NotoSansSC-Regular.otf | Hans,Hant,Jpan\n")).0);
        let ctx = egui::Context::default();
        crate::theme::install_fonts(&ctx);
        // A font arrives during a frame (`WebShell::logic`), so the active stack exists.
        ctx.run_ui(Default::default(), |_| {}).textures_delta.clear();
        assert!(install_ui_delivered(&ctx, &[(family.into(), bytes)]), "a script fallback is stored");
        assert!(has_chinese(&ctx), "has_glyphs(\"中文\")");
        for code in ["zh-hans", "en", "zh-hans"] {
            crate::i18n::sync_context(&ctx, code);
            assert!(has_chinese(&ctx), "Chinese glyphs after switching to {code}");
        }
        crate::theme::install_fonts(&ctx);
        assert!(has_chinese(&ctx), "Chinese glyphs after a font-stack rebuild");
        let definitions = ctx.fonts(|f| f.definitions().clone());
        let name = ui_font_name(family);
        for (family, stack) in &definitions.families {
            assert_eq!(stack.last(), Some(&name), "{family:?}: the served font stays the last fallback");
        }
        assert_eq!(definitions.families[&egui::FontFamily::Proportional].first().map(String::as_str), Some("Inter"));
        // A repeat delivery is ignored: the bytes and the stack entry stay single.
        assert!(!install_ui_delivered(&ctx, &[(family.into(), Vec::new())]));
    }
}
