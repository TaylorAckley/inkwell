use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use comrak::{markdown_to_html, Options};

/// GitHub-flavoured markdown to HTML.
///
/// Block elements carry `data-sourcepos="line:col-line:col"`, which the
/// frontend uses to keep the editor and preview scrolled to the same place.
/// Raw HTML in the document is allowed but passed through ammonia, so a
/// hostile .md file can't run script inside the app.
///
/// This runs on every keystroke, so it avoids the expensive steps when it
/// can: a document without any `<` has no raw HTML, and comrak's safe mode
/// (which also drops `javascript:` and similar links) is enough, skipping
/// ammonia, which is most of the cost.
pub fn render(source: &str) -> String {
    let raw_html = source.contains('<');
    let mut o = Options::default();
    o.extension.strikethrough = true;
    o.extension.table = true;
    o.extension.autolink = true;
    o.extension.tasklist = true;
    o.extension.footnotes = true;
    o.extension.front_matter_delimiter = Some("---".to_owned());
    // $inline$, $$display$$ and ```math blocks, emitted as
    // data-math-style elements for KaTeX in the frontend.
    o.extension.math_dollars = true;
    o.extension.math_code = true;
    o.render.sourcepos = true;
    o.render.unsafe_ = raw_html;
    o.render.github_pre_lang = false;
    // Heading anchors are added by `anchor_headings`: comrak's own
    // de-duplication is quadratic in the number of repeated headings.

    let html = anchor_headings(&markdown_to_html(source, &o));
    if raw_html {
        sanitizer().clean(&html).to_string()
    } else {
        html
    }
}

/// GitHub-style heading slug: lowercase, punctuation dropped, spaces to dashes.
fn slug(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_'))
        .map(|c| if c == ' ' { '-' } else { c })
        .collect()
}

/// The text of a fragment of HTML: tags removed, basic entities decoded.
fn html_text(html: &str) -> String {
    let mut text = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => text.push(c),
            _ => {}
        }
    }
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&")
}

/// Give every heading a unique anchor (`intro`, `intro-1`, …) in one pass,
/// in the same shape comrak uses: `<h2><a href="#id" aria-hidden="true"
/// class="anchor" id="id"></a>Text</h2>`.
fn anchor_headings(html: &str) -> String {
    let mut out = String::with_capacity(html.len() + html.len() / 16);
    let mut used = HashSet::new();
    let mut next_suffix: HashMap<String, usize> = HashMap::new();
    let mut rest = html;
    while let Some(i) = rest.find("<h") {
        let level = rest.as_bytes().get(i + 2).copied();
        let after = rest.as_bytes().get(i + 3).copied();
        let is_heading = matches!(level, Some(b'1'..=b'6')) && matches!(after, Some(b'>' | b' '));
        let (Some(open_end), true) = (rest[i..].find('>').map(|j| i + j + 1), is_heading) else {
            out.push_str(&rest[..i + 2]);
            rest = &rest[i + 2..];
            continue;
        };
        let close = format!("</h{}>", level.unwrap() as char);
        let Some(close_at) = rest[open_end..].find(&close).map(|j| open_end + j) else {
            out.push_str(&rest[..open_end]);
            rest = &rest[open_end..];
            continue;
        };
        let base = slug(&html_text(&rest[open_end..close_at]));
        let mut id = base.clone();
        if used.contains(&id) {
            let n = next_suffix.entry(base.clone()).or_insert(1);
            while used.contains(&format!("{base}-{n}")) {
                *n += 1;
            }
            id = format!("{base}-{n}");
            *n += 1;
        }
        used.insert(id.clone());
        out.push_str(&rest[..open_end]);
        out.push_str(&format!(r##"<a href="#{id}" aria-hidden="true" class="anchor" id="{id}"></a>"##));
        rest = &rest[open_end..];
    }
    out.push_str(rest);
    out
}

fn sanitizer() -> &'static ammonia::Builder<'static> {
    static SANITIZER: OnceLock<ammonia::Builder<'static>> = OnceLock::new();
    SANITIZER.get_or_init(|| {
        let mut b = ammonia::Builder::default();
        b.add_generic_attributes(&["data-sourcepos", "data-math-style", "class", "id", "align"])
            .add_tags(&["input"])
            .add_tag_attributes("input", &["type", "checked", "disabled"]);
        b
    })
}

#[cfg(test)]
mod tests {
    use super::render;

    #[test]
    fn keeps_sourcepos_and_strips_script() {
        let html = render("# Hi\n\n<script>alert(1)</script>\n\n- [x] done\n");
        assert!(html.contains("data-sourcepos=\"1:1-1:4\""));
        assert!(!html.contains("<script"));
        assert!(html.contains("type=\"checkbox\""));
    }

    #[test]
    fn math_is_tagged_for_katex() {
        let html = render("Inline $e^x$ and\n\n$$\\int_0^1 x$$\n");
        assert!(html.contains("data-math-style=\"inline\""));
        assert!(html.contains("data-math-style=\"display\""));
    }

    #[test]
    fn code_blocks_get_language_class() {
        let html = render("```rust\nfn main() {}\n```\n");
        assert!(html.contains("class=\"language-rust\""));
    }

    #[test]
    fn unique_heading_anchors() {
        let html = render("# Intro\n\n## Fixed\n\n## Fixed\n\n## Fixed-1\n\n## Fixed\n\n### Q&A: *it's* `code`\n");
        for id in ["intro", "fixed", "fixed-1", "fixed-1-1", "fixed-2", "qa-its-code"] {
            assert!(html.contains(&format!(r##"<a href="#{id}" aria-hidden="true" class="anchor" id="{id}"></a>"##)), "missing {id} in {html}");
        }
        // Not headings: <hr>, <header>, and headings shown as code.
        let html = render("text\n\n---\n\n<header>x</header>\n\n`<h2>not</h2>`\n");
        assert!(!html.contains("class=\"anchor\""), "{html}");
    }

    #[test]
    fn fast_path_still_blocks_dangerous_links() {
        // No '<' anywhere, so ammonia is skipped; comrak's safe mode must catch these.
        let html = render("[x](javascript:alert(1)) [y](vbscript:msgbox) ![z](data:image/png;base64,AAAA)");
        assert!(!html.contains("javascript:"), "{html}");
        assert!(!html.contains("vbscript:"), "{html}");
        assert!(html.contains("data:image/png"), "{html}");
    }

    #[test]
    fn many_repeated_headings_stay_linear() {
        let time = |n: usize| {
            let doc = "## Fixed\n\ntext\n\n".repeat(n);
            let start = std::time::Instant::now();
            let html = render(&doc);
            let elapsed = start.elapsed();
            assert!(html.contains(&format!("id=\"fixed-{}\"", n - 1)));
            elapsed
        };
        time(100); // warm up
        let small = time(2_000);
        let large = time(20_000); // ~360 KB
        // 10x the headings: linear is ~10x the time, comrak's quadratic anchorizer was ~100x.
        // Comparing against the small run keeps this independent of machine speed.
        let ratio = large.as_secs_f64() / small.as_secs_f64().max(1e-6);
        assert!(ratio < 30.0, "2k took {small:?}, 20k took {large:?} ({ratio:.1}x)");
    }
}
