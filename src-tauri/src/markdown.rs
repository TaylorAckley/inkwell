use std::sync::OnceLock;

use comrak::{markdown_to_html, Options};

/// GitHub-flavoured markdown to HTML.
///
/// Block elements carry `data-sourcepos="line:col-line:col"`, which the
/// frontend uses to keep the editor and preview scrolled to the same place.
/// Raw HTML in the document is allowed but passed through ammonia, so a
/// hostile .md file can't run script inside the app.
pub fn render(source: &str) -> String {
    let mut o = Options::default();
    o.extension.strikethrough = true;
    o.extension.table = true;
    o.extension.autolink = true;
    o.extension.tasklist = true;
    o.extension.footnotes = true;
    o.extension.header_ids = Some(String::new());
    o.extension.front_matter_delimiter = Some("---".to_owned());
    // $inline$, $$display$$ and ```math blocks, emitted as
    // data-math-style elements for KaTeX in the frontend.
    o.extension.math_dollars = true;
    o.extension.math_code = true;
    o.render.sourcepos = true;
    o.render.unsafe_ = true;
    o.render.github_pre_lang = false;

    let html = markdown_to_html(source, &o);
    sanitizer().clean(&html).to_string()
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
}
