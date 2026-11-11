//! A design's page as one standalone HTML file (X99 Download): everything it
//! loads from the design's files inlined, so it opens in any browser with no
//! moonlet running.

use std::cell::RefCell;
use std::collections::HashSet;
use std::path::Path;

use base64::Engine;
use regex::Regex;

/// A page with its files inlined, and the addresses it could not read.
#[derive(Debug, PartialEq, Eq)]
pub struct Standalone {
    pub html: String,
    pub missing: Vec<String>,
}

/// Where an address in a page or a stylesheet leads.
enum Address {
    /// Outside the design's files (`https:`, `data:`, `//host`, `#id`): left
    /// as it is.
    Away,
    /// A file, as a path from the root.
    File(String),
    /// Above the root: never read.
    Out,
}

/// Where `addr`, written in the file at `base`, leads.
fn resolve(base: &str, addr: &str) -> Address {
    let addr = addr.trim();
    let scheme = addr.find(':').is_some_and(|c| addr[..c].chars().all(|ch| ch.is_ascii_alphanumeric() || "+-.".contains(ch)) && c > 0);
    if addr.is_empty() || addr.starts_with('#') || addr.starts_with("//") || scheme {
        return Address::Away;
    }
    let addr = addr.split(['?', '#']).next().unwrap_or_default();
    let mut parts: Vec<&str> = match addr.strip_prefix('/') {
        Some(_) => Vec::new(),
        None => base.split('/').collect::<Vec<_>>().split_last().map(|(_, dir)| dir.to_vec()).unwrap_or_default(),
    };
    for seg in addr.trim_start_matches('/').split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Address::Out;
                }
            }
            s => parts.push(s),
        }
    }
    Address::File(parts.join("/"))
}

/// What inlines a page's files: the reader, and the addresses it missed.
struct Inliner<R> {
    read: R,
    missing: Vec<String>,
}

impl<R: FnMut(&str) -> Option<Vec<u8>>> Inliner<R> {
    /// The file `addr` written in `base` leads to, or none (listed as
    /// missing) when it leads above the root or cannot be read; `Ok(None)`
    /// for an address outside the design's files.
    fn file(&mut self, base: &str, addr: &str) -> Result<Option<(String, Vec<u8>)>, ()> {
        match resolve(base, addr) {
            Address::Away => Ok(None),
            Address::File(path) => match (self.read)(&path) {
                Some(bytes) => Ok(Some((path, bytes))),
                None => self.miss(addr),
            },
            Address::Out => self.miss(addr),
        }
    }

    fn miss<T>(&mut self, addr: &str) -> Result<T, ()> {
        if !self.missing.iter().any(|m| m == addr) {
            self.missing.push(addr.to_string());
        }
        Err(())
    }

    /// `addr` in `base` as a `data:` URL, or `addr` as it is.
    fn data_url(&mut self, base: &str, addr: &str) -> String {
        match self.file(base, addr) {
            Ok(Some((path, bytes))) => {
                let mime = crate::design::store::content_type(Path::new(&path));
                let mime = mime.split(';').next().unwrap_or(mime);
                format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
            }
            _ => addr.to_string(),
        }
    }

    /// The stylesheet `text`, at `base`, with its `@import`s replaced by the
    /// sheets they import and its `url()`s by `data:` URLs.
    fn css(&mut self, base: &str, text: &str, seen: &mut HashSet<String>) -> String {
        let import = Regex::new(r#"@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?\s*([^;]*);"#).expect("import pattern");
        let url = Regex::new(r#"url\(\s*["']?([^"')]+?)["']?\s*\)"#).expect("url pattern");
        // Imports stand aside while this sheet's own url()s are inlined.
        let mut imports = Vec::new();
        let text = import.replace_all(text, |c: &regex::Captures| {
            imports.push((c[0].to_string(), c[1].to_string(), c[2].trim().to_string()));
            format!("\u{0}{}\u{0}", imports.len() - 1)
        });
        let mut text = url.replace_all(&text, |c: &regex::Captures| format!("url(\"{}\")", self.data_url(base, &c[1]))).into_owned();
        for (i, (statement, addr, media)) in imports.into_iter().enumerate() {
            let inlined = match self.file(base, &addr) {
                Ok(Some((path, bytes))) if seen.insert(path.clone()) => {
                    let sheet = self.css(&path, &String::from_utf8_lossy(&bytes), seen);
                    if media.is_empty() { sheet } else { format!("@media {media} {{\n{sheet}\n}}") }
                }
                _ => statement,
            };
            text = text.replacen(&format!("\u{0}{i}\u{0}"), &inlined, 1);
        }
        text
    }
}

/// `html`, the page at `page` (a path from the root `read` reads from), with
/// what it loads from there inlined: stylesheets, with their `@import`s, as
/// `<style>`; scripts as inline `<script>`; images, icons, media and every
/// stylesheet `url()` as `data:` URLs. An address outside the root's files is
/// left as it is; one that leads above the root, or cannot be read, is left
/// too, and listed in `missing`.
pub fn inline(page: &str, html: &str, read: impl FnMut(&str) -> Option<Vec<u8>>) -> Standalone {
    use lol_html::html_content::ContentType;
    use lol_html::{element, text};

    let inliner = RefCell::new(Inliner { read, missing: Vec::new() });
    let style = RefCell::new(String::new());
    let rel_has = |el: &lol_html::html_content::Element, word: &str| {
        el.get_attribute("rel").is_some_and(|r| r.split_ascii_whitespace().any(|w| w.eq_ignore_ascii_case(word)))
    };
    let settings = lol_html::Settings::new()
        .append_element_content_handler(element!("link[href]", |el| {
            let href = el.get_attribute("href").unwrap_or_default();
            if rel_has(el, "stylesheet") {
                let mut i = inliner.borrow_mut();
                if let Ok(Some((path, bytes))) = i.file(page, &href) {
                    let sheet = i.css(&path, &String::from_utf8_lossy(&bytes), &mut HashSet::from([path.clone()]));
                    el.replace(&format!("<style>{}</style>", sheet.replace("</style", "<\\/style")), ContentType::Html);
                }
            } else if rel_has(el, "icon") {
                let url = inliner.borrow_mut().data_url(page, &href);
                el.set_attribute("href", &url)?;
            }
            Ok(())
        }))
        .append_element_content_handler(element!("script[src]", |el| {
            let src = el.get_attribute("src").unwrap_or_default();
            if let Ok(Some((_, bytes))) = inliner.borrow_mut().file(page, &src) {
                el.remove_attribute("src");
                el.set_inner_content(&String::from_utf8_lossy(&bytes).replace("</script", "<\\/script"), ContentType::Html);
            }
            Ok(())
        }))
        .append_element_content_handler(element!("img[src], source[src], audio[src], video[src], input[src], track[src]", |el| {
            let src = el.get_attribute("src").unwrap_or_default();
            let url = inliner.borrow_mut().data_url(page, &src);
            el.set_attribute("src", &url)?;
            Ok(())
        }))
        .append_element_content_handler(element!("video[poster]", |el| {
            let poster = el.get_attribute("poster").unwrap_or_default();
            let url = inliner.borrow_mut().data_url(page, &poster);
            el.set_attribute("poster", &url)?;
            Ok(())
        }))
        .append_element_content_handler(element!("[style]", |el| {
            let css = el.get_attribute("style").unwrap_or_default();
            let css = inliner.borrow_mut().css(page, &css, &mut HashSet::new());
            el.set_attribute("style", &css)?;
            Ok(())
        }))
        .append_element_content_handler(text!("style", |t| {
            style.borrow_mut().push_str(t.as_str());
            if t.last_in_text_node() {
                let css = std::mem::take(&mut *style.borrow_mut());
                let css = inliner.borrow_mut().css(page, &css, &mut HashSet::new());
                t.replace(&css, ContentType::Html);
            } else {
                t.remove();
            }
            Ok(())
        }));
    let html = lol_html::rewrite_str(html, settings).unwrap_or_else(|_| html.to_string());
    Standalone { html, missing: inliner.into_inner().missing }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn files(list: &[(&str, &[u8])]) -> HashMap<String, Vec<u8>> {
        list.iter().map(|(p, b)| (p.to_string(), b.to_vec())).collect()
    }

    #[test]
    fn a_page_comes_with_its_stylesheets_imports_fonts_images_and_scripts_inlined() {
        let files = files(&[
            ("systems/s/styles.css", b"@import \"tokens/colors.css\";\nbody { font-family: Inter; }\n@font-face { src: url(\"fonts/inter.woff2\"); }"),
            ("systems/s/tokens/colors.css", b":root { --c: red; }"),
            ("systems/s/fonts/inter.woff2", &[0, 1, 2]),
            ("designs/d/assets/logo.png", &[1, 2, 3]),
            ("designs/d/pages/app.js", b"go()"),
        ]);
        let page = "<html><head><link rel=\"stylesheet\" href=\"../../../systems/s/styles.css\"></head><body><img src=\"../assets/logo.png\" alt=\"Logo\"><script src=\"app.js\"></script></body></html>";
        let out = inline("designs/d/pages/index.html", page, |p| files.get(p).cloned());
        assert_eq!(
            out,
            Standalone {
                html: "<html><head><style>:root { --c: red; }\nbody { font-family: Inter; }\n@font-face { src: url(\"data:font/woff2;base64,AAEC\"); }</style></head><body><img src=\"data:image/png;base64,AQID\" alt=\"Logo\"><script>go()</script></body></html>".into(),
                missing: vec![],
            }
        );
    }

    #[test]
    fn addresses_outside_the_designs_files_are_left_as_they_are() {
        let page = "<link rel=\"stylesheet\" href=\"https://fonts.example.com/a.css\"><img src=\"data:image/png;base64,AA\"><script src=\"//cdn.example.com/x.js\"></script><a href=\"#top\">Top</a><div style=\"background: url(https://example.com/b.png)\"></div>";
        let out = inline("designs/d/pages/index.html", page, |_| Some(b"never".to_vec()));
        assert_eq!(
            out,
            Standalone {
                html: "<link rel=\"stylesheet\" href=\"https://fonts.example.com/a.css\"><img src=\"data:image/png;base64,AA\"><script src=\"//cdn.example.com/x.js\"></script><a href=\"#top\">Top</a><div style=\"background: url(&quot;https://example.com/b.png&quot;)\"></div>".into(),
                missing: vec![],
            }
        );
    }

    #[test]
    fn an_address_that_cannot_be_read_or_leaves_the_root_is_left_and_listed() {
        let page = "<img src=\"../assets/gone.png\"><img src=\"../../../../etc/passwd\"><style>.a { background: url('../assets/gone.png') }</style>";
        // Every file reads, so only the check keeps a path above the root out.
        let out = inline("designs/d/pages/index.html", page, |p| (p != "designs/d/assets/gone.png").then(|| b"secret".to_vec()));
        assert_eq!(
            out,
            Standalone {
                html: "<img src=\"../assets/gone.png\"><img src=\"../../../../etc/passwd\"><style>.a { background: url(\"../assets/gone.png\") }</style>".into(),
                missing: vec!["../assets/gone.png".into(), "../../../../etc/passwd".into()],
            }
        );
    }

    #[test]
    fn an_import_with_media_is_kept_to_its_media_and_an_import_cycle_ends() {
        let files = files(&[
            ("s/a.css", b"@import url(b.css) print;\n.a {}"),
            ("s/b.css", b"@import \"a.css\";\n.b {}"),
        ]);
        let out = inline("p.html", "<link rel=\"stylesheet\" href=\"s/a.css\">", |p| files.get(p).cloned());
        assert_eq!(out.html, "<style>@media print {\n@import \"a.css\";\n.b {}\n}\n.a {}</style>");
    }
}
