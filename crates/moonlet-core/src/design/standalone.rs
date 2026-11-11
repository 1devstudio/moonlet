//! A design's page as one standalone HTML file (X99 Download): everything it
//! loads from the design's files inlined, so it opens in any browser with no
//! moonlet running.

use std::cell::RefCell;
use std::collections::HashSet;
use std::path::Path;
use std::sync::LazyLock;

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
        let (kept, rules) = self.sheet(base, text, seen);
        if kept.is_empty() { rules } else { format!("{}\n{rules}", kept.join("\n")) }
    }

    /// [`Self::css`]'s rules, and apart from them the `@import`s left as they
    /// are (an address outside the design's files, one not read), which a
    /// browser takes only before every rule.
    fn sheet(&mut self, base: &str, text: &str, seen: &mut HashSet<String>) -> (Vec<String>, String) {
        // Imports stand aside while this sheet's own url()s are inlined.
        let mut imports = Vec::new();
        let text = IMPORT.replace_all(text, |c: &regex::Captures| {
            let addr = c.get(1).or(c.get(2)).or(c.get(3)).map_or("", |m| m.as_str()).to_string();
            imports.push((c[0].to_string(), addr, c[4].trim().to_string()));
            format!("\u{0}{}\u{0}", imports.len() - 1)
        });
        let mut text = URL.replace_all(&text, |c: &regex::Captures| format!("url(\"{}\")", self.data_url(base, &c[1]))).into_owned();
        let mut kept = Vec::new();
        for (i, (statement, addr, conditions)) in imports.into_iter().enumerate() {
            let inlined = match self.file(base, &addr) {
                Ok(Some((path, bytes))) => {
                    // An import cycle ends where a sheet comes again.
                    if seen.insert(path.clone()) {
                        let (more, rules) = self.sheet(&path, &String::from_utf8_lossy(&bytes), seen);
                        kept.extend(more);
                        Some(wrap(&conditions, rules))
                    } else {
                        None
                    }
                }
                _ => {
                    kept.push(statement);
                    None
                }
            };
            let mark = format!("\u{0}{i}\u{0}");
            text = match inlined {
                Some(rules) => text.replacen(&mark, &rules, 1),
                None => text.replacen(&format!("{mark}\n"), "", 1).replacen(&mark, "", 1),
            };
        }
        (kept, text)
    }
}

/// An `@import`: its address (double-quoted, single-quoted or bare, with or
/// without `url()`), then its layer, supports and media conditions. CSS
/// keywords are case-insensitive, and the space after `@import` optional.
static IMPORT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)@import\s*(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^"'()\s;]+))\s*\)?\s*([^;]*);"#).expect("import pattern")
});

/// A `url()`, its address unquoted.
static URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)url\(\s*["']?([^"')]+?)["']?\s*\)"#).expect("url pattern"));

/// `rules` under an import's `conditions`: `layer` or `layer(name)`, then
/// `supports(…)`, then a media query list, each kept as the rule it stands
/// for.
fn wrap(conditions: &str, rules: String) -> String {
    let mut rest = conditions.trim();
    let mut open = Vec::new();
    if let Some(after) = strip_keyword(rest, "layer") {
        match call_args(after) {
            Some((name, tail)) => {
                open.push(format!("@layer {}", name.trim()));
                rest = tail;
            }
            None => {
                open.push("@layer".to_string());
                rest = after;
            }
        }
        rest = rest.trim_start();
    }
    if let Some((test, tail)) = strip_keyword(rest, "supports").and_then(call_args) {
        let test = test.trim();
        open.push(if test.starts_with('(') { format!("@supports {test}") } else { format!("@supports ({test})") });
        rest = tail.trim_start();
    }
    if !rest.is_empty() {
        open.push(format!("@media {rest}"));
    }
    open.into_iter().rev().fold(rules, |inner, rule| format!("{rule} {{\n{inner}\n}}"))
}

/// A `srcset`'s candidates: each one's address, and its descriptor with the
/// space before it (`" 2x"`), or none. An address runs to the first space,
/// so a `data:` URL's commas stay in it.
fn candidates(set: &str) -> Vec<(&str, &str)> {
    let mut out = Vec::new();
    let mut rest = set;
    loop {
        rest = rest.trim_start_matches(|c: char| c.is_whitespace() || c == ',');
        if rest.is_empty() {
            return out;
        }
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        let (url, after) = rest.split_at(end);
        if let Some(url) = url.strip_suffix(',') {
            out.push((url, ""));
            rest = after;
            continue;
        }
        let stop = after.find(',').unwrap_or(after.len());
        out.push((url, after[..stop].trim_end()));
        rest = &after[stop..];
    }
}

/// What follows `keyword` at the start of `s`, ignoring case.
fn strip_keyword<'a>(s: &'a str, keyword: &str) -> Option<&'a str> {
    let head = s.get(..keyword.len())?;
    head.eq_ignore_ascii_case(keyword).then(|| &s[keyword.len()..])
}

/// `(…)` at the start of `s`: what is inside, with nested parentheses, and
/// what follows.
fn call_args(s: &str) -> Option<(&str, &str)> {
    let s = s.strip_prefix('(')?;
    let mut depth = 1;
    for (i, ch) in s.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some((&s[..i], &s[i + 1..]));
                }
            }
            _ => {}
        }
    }
    None
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
                    let media = el.get_attribute("media").map(|m| format!(" media=\"{}\"", m.replace('&', "&amp;").replace('"', "&quot;"))).unwrap_or_default();
                    el.replace(&format!("<style{media}>{}</style>", sheet.replace("</style", "<\\/style")), ContentType::Html);
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
        .append_element_content_handler(element!("img[srcset], source[srcset]", |el| {
            let set = el.get_attribute("srcset").unwrap_or_default();
            let mut i = inliner.borrow_mut();
            let set = candidates(&set).into_iter().map(|(url, descriptor)| format!("{}{descriptor}", i.data_url(page, url))).collect::<Vec<_>>().join(", ");
            el.set_attribute("srcset", &set)?;
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
        assert_eq!(out.html, "<style>@media print {\n.b {}\n}\n.a {}</style>");
    }

    #[test]
    fn an_import_written_in_capitals_or_with_no_space_is_inlined_too() {
        let files = files(&[("s/a.css", b"@IMPORT\"b.css\";\n.a {}"), ("s/b.css", b".b {}")]);
        let out = inline("p.html", "<link rel=\"stylesheet\" href=\"s/a.css\">", |p| files.get(p).cloned());
        assert_eq!(out.html, "<style>.b {}\n.a {}</style>");
    }

    #[test]
    fn an_import_left_as_it_is_goes_first_where_a_browser_still_takes_it() {
        let files = files(&[("s/a.css", b"@import \"local.css\";\n@import url(https://fonts.example.com/x.css);\n.a {}"), ("s/local.css", b".l {}")]);
        let out = inline("p.html", "<link rel=\"stylesheet\" href=\"s/a.css\">", |p| files.get(p).cloned());
        assert_eq!(out.html, "<style>@import url(https://fonts.example.com/x.css);\n.l {}\n.a {}</style>");
    }

    #[test]
    fn an_import_into_a_layer_under_a_supports_and_a_media_keeps_all_three() {
        let files = files(&[("s/a.css", b"@import \"b.css\" layer(base) supports(display: grid) screen;"), ("s/b.css", b".b {}")]);
        let out = inline("p.html", "<link rel=\"stylesheet\" href=\"s/a.css\">", |p| files.get(p).cloned());
        assert_eq!(out.html, "<style>@layer base {\n@supports (display: grid) {\n@media screen {\n.b {}\n}\n}\n}</style>");
    }

    #[test]
    fn a_stylesheet_link_keeps_its_media_and_an_images_srcset_is_inlined_too() {
        let files = files(&[("p/print.css", b".p {}"), ("p/a.png", &[1, 2, 3]), ("p/b.png", &[4, 5, 6])]);
        let page = "<link rel=\"stylesheet\" href=\"print.css\" media=\"print\"><img src=\"a.png\" srcset=\"a.png 1x, b.png 2x, https://x.example/c.png 3x\">";
        let out = inline("p/index.html", page, |p| files.get(p).cloned());
        assert_eq!(
            out.html,
            "<style media=\"print\">.p {}</style><img src=\"data:image/png;base64,AQID\" srcset=\"data:image/png;base64,AQID 1x, data:image/png;base64,BAUG 2x, https://x.example/c.png 3x\">"
        );
    }
}
