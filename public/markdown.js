export function renderMarkdown(element, source) {
    const html = marked.parse(source, { async: false, gfm: true, breaks: true });
    const safeHtml = DOMPurify.sanitize(html, {
        ALLOWED_TAGS: [
            "p",
            "br",
            "strong",
            "em",
            "del",
            "s",
            "ul",
            "ol",
            "li",
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
            "blockquote",
            "pre",
            "code",
            "a",
            "hr",
            "table",
            "thead",
            "tbody",
            "tr",
            "th",
            "td",
        ],
        ALLOWED_ATTR: ["href", "title", "class", "start"],
        ALLOW_DATA_ATTR: false,
        ALLOW_ARIA_ATTR: false,
    });
    element.classList.add("markdown-body");
    element.innerHTML = safeHtml;
    for (const code of element.querySelectorAll("pre code"))
        window.Prism?.highlightElement(code);
    for (const link of element.querySelectorAll("a[href]")) {
        const href = link.getAttribute("href") || "";
        // Only navigation links are allowed; model output cannot execute a URL.
        if (/^(?:https?:\/\/|mailto:)/i.test(href)) {
            link.setAttribute("target", "_blank");
            link.setAttribute("rel", "noopener noreferrer");
        }
        else if (!/^(?:#|\/(?!\/)|\.\.?\/)/.test(href)) {
            link.removeAttribute("href");
        }
    }
}
