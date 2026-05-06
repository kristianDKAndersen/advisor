"""DOM HTML → indexed text + JSON selector map."""
from __future__ import annotations

import json
from typing import Any

from bs4 import BeautifulSoup, NavigableString, Tag

INTERACTIVE_TAGS = {"a", "button", "input", "select", "textarea"}
KEEP_ATTRS = {"href", "src", "type", "placeholder", "value", "aria-label", "role", "action", "name"}
BLOCK_TEXT_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "td", "th", "caption", "title"}
SKIP_TAGS = {"script", "style", "noscript", "head", "meta", "link"}
MAX_CHARS = 24_000


def _has_interactive_descendant(tag: Tag) -> bool:
    return bool(tag.find(INTERACTIVE_TAGS))


def _attr_str(tag: Tag) -> str:
    parts = []
    for k, v in tag.attrs.items():
        if k in KEEP_ATTRS and v:
            val = v if isinstance(v, str) else " ".join(v)
            parts.append(f'{k}="{val}"')
    return (" " + " ".join(parts)) if parts else ""


def serialize(
    html: str,
    url: str,
    title: str,
    scroll_y: int = 0,
    prev_indices: set[int] | None = None,
) -> tuple[str, dict[int, dict[str, Any]]]:
    """Return (dom_text, selector_map)."""
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(SKIP_TAGS):
        tag.decompose()

    lines: list[str] = [
        f"URL: {url}",
        f"Title: {title}",
        f"Scroll: {scroll_y}px",
        "",
    ]
    selector_map: dict[int, dict[str, Any]] = {}
    counter = [0]
    char_count = [sum(len(l) + 1 for l in lines)]
    truncated = [False]

    def _node_xpath(tag: Tag) -> str:
        parts: list[str] = []
        node: Any = tag
        while node and getattr(node, "name", None):
            parent = node.parent
            if parent:
                siblings = [s for s in parent.children if isinstance(s, Tag) and s.name == node.name]
                idx = (siblings.index(node) + 1) if node in siblings else 1
            else:
                idx = 1
            parts.append(f"{node.name}[{idx}]")
            node = parent
        parts.reverse()
        return "/" + "/".join(parts) if parts else "/"

    def _append(line: str) -> bool:
        cost = len(line) + 1
        if char_count[0] + cost > MAX_CHARS:
            lines.append(f"--- TRUNCATED ({char_count[0]} chars) ---")
            truncated[0] = True
            return False
        lines.append(line)
        char_count[0] += cost
        return True

    def _walk(node: Any) -> None:
        if truncated[0]:
            return
        if isinstance(node, NavigableString):
            return
        if not isinstance(node, Tag):
            return

        tag_name = node.name.lower() if node.name else ""

        if tag_name in SKIP_TAGS:
            return

        if tag_name in INTERACTIVE_TAGS:
            counter[0] += 1
            idx = counter[0]
            text = node.get_text(separator=" ", strip=True)
            attrs = {}
            for k, v in node.attrs.items():
                if k in KEEP_ATTRS and v:
                    attrs[k] = v if isinstance(v, str) else " ".join(v)

            is_new = prev_indices is not None and idx not in prev_indices
            prefix = "*" if is_new else ""
            attr_s = _attr_str(node)
            line = f"{prefix}[{idx}]<{tag_name}{attr_s}>{text[:120]}</{tag_name}>"
            if not _append(line):
                return
            selector_map[idx] = {
                "tag": tag_name,
                "text": text[:120],
                "attrs": attrs,
                "interactive": True,
                "xpath": _node_xpath(node),
            }
            return  # Don't recurse into interactive elements

        # Block text nodes: render text only if no interactive descendants
        if tag_name in BLOCK_TEXT_TAGS:
            if not _has_interactive_descendant(node):
                text = node.get_text(separator=" ", strip=True)
                if text:
                    _append(f"<{tag_name}>{text[:200]}</{tag_name}>")
                return
            # Has interactive descendants: recurse to find them
            for child in node.children:
                _walk(child)
            return

        # All other elements: recurse
        for child in node.children:
            _walk(child)

    body = soup.find("body") or soup
    _walk(body)

    dom_text = "\n".join(lines)
    return dom_text, selector_map
