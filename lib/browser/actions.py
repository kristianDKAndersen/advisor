"""Action handler coroutines for the browser daemon."""
from __future__ import annotations

import asyncio
import base64
import json
import re
import urllib.parse
from pathlib import Path
from typing import Any

import markdownify
from lib.browser.dom_serializer import serialize as dom_serialize


async def navigate(client: Any, params: dict, session_dir: Path) -> dict:
    url = params.get("url", "")
    if not url.startswith(("http://", "https://", "about:", "file:")):
        url = "https://" + url
    result = await client.send_raw("Page.navigate", {"url": url})
    # Wait for load
    await asyncio.sleep(1.5)
    info = await client.send_raw("Runtime.evaluate", {
        "expression": "JSON.stringify({url: location.href, title: document.title})",
        "returnByValue": True,
    })
    data = json.loads(info.get("result", {}).get("value", "{}"))
    return {"url": data.get("url", url), "title": data.get("title", "")}


async def click_index(client: Any, params: dict, selector_map: dict[int, dict]) -> dict:
    idx = params.get("index")
    if idx not in selector_map:
        return {"error": f"index {idx} not in selector map"}
    entry = selector_map[idx]
    xpath = entry.get("xpath", "")
    js = f"""
(function() {{
    var r = document.evaluate({json.dumps(xpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    var el = r.singleNodeValue;
    if (!el) return JSON.stringify({{ok: false, error: 'element not found'}});
    el.click();
    return JSON.stringify({{ok: true, clicked: el.textContent.trim().slice(0, 80)}});
}})()
"""
    result = await client.send_raw("Runtime.evaluate", {"expression": js, "returnByValue": True})
    val = result.get("result", {}).get("value", "{}")
    data = json.loads(val) if val else {"ok": False, "error": "no response"}
    if not data.get("ok"):
        return {"error": data.get("error", "click failed")}
    await asyncio.sleep(0.5)
    url_result = await client.send_raw("Runtime.evaluate", {
        "expression": "location.href",
        "returnByValue": True,
    })
    new_url = url_result.get("result", {}).get("value")
    return {"clicked": data.get("clicked", ""), "new_url": new_url}


async def input_text(client: Any, params: dict, selector_map: dict[int, dict]) -> dict:
    idx = params.get("index")
    text = params.get("text", "")
    clear = params.get("clear", True)
    if idx not in selector_map:
        return {"error": f"index {idx} not in selector map"}
    entry = selector_map[idx]
    xpath = entry.get("xpath", "")
    js = f"""
(function() {{
    var r = document.evaluate({json.dumps(xpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    var el = r.singleNodeValue;
    if (!el) return JSON.stringify({{ok: false, error: 'element not found'}});
    el.focus();
    if ({json.dumps(clear)}) {{ el.value = ''; el.dispatchEvent(new Event('input', {{bubbles: true}})); }}
    return JSON.stringify({{ok: true, tag: el.tagName}});
}})()
"""
    result = await client.send_raw("Runtime.evaluate", {"expression": js, "returnByValue": True})
    val = result.get("result", {}).get("value", "{}")
    data = json.loads(val) if val else {"ok": False, "error": "no response"}
    if not data.get("ok"):
        return {"error": data.get("error", "focus failed")}
    # Type text character by character via insertText
    await client.send_raw("Input.insertText", {"text": text})
    # Read back value
    js2 = f"""
(function() {{
    var r = document.evaluate({json.dumps(xpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    var el = r.singleNodeValue;
    return el ? el.value : null;
}})()
"""
    res2 = await client.send_raw("Runtime.evaluate", {"expression": js2, "returnByValue": True})
    confirmed = res2.get("result", {}).get("value")
    return {"typed": text, "confirmed_value": confirmed}


async def scroll(client: Any, params: dict) -> dict:
    down = params.get("down", True)
    pages = params.get("pages", 1.0)
    js = f"""
(function() {{
    var vh = window.innerHeight;
    var dy = {pages} * vh * {'1' if down else '-1'};
    window.scrollBy(0, dy);
    return Math.round(dy);
}})()
"""
    result = await client.send_raw("Runtime.evaluate", {"expression": js, "returnByValue": True})
    scrolled = result.get("result", {}).get("value", 0)
    return {"scrolled_px": scrolled}


async def extract(client: Any, params: dict) -> dict:
    result = await client.send_raw("Runtime.evaluate", {
        "expression": "document.documentElement.outerHTML",
        "returnByValue": True,
    })
    html = result.get("result", {}).get("value", "")
    md = markdownify.markdownify(html, heading_style="ATX")
    # Clean up excessive blank lines
    md = re.sub(r"\n{3,}", "\n\n", md).strip()
    limit = 8 * 1024  # 8kB
    if len(md) > limit:
        md = md[:limit] + "\n\n[...truncated, content exceeds 8kB]"
    return {"extracted_content": md}


async def screenshot(client: Any, params: dict, session_dir: Path, output_dir: Path | None = None) -> dict:
    file_name = params.get("file_name")
    result = await client.send_raw("Page.captureScreenshot", {"format": "png"})
    data = result.get("data", "")
    img_bytes = base64.b64decode(data)

    if file_name and output_dir:
        out = output_dir / "browser" / "screenshots"
        out.mkdir(parents=True, exist_ok=True)
        path = out / file_name
    else:
        path = session_dir / "state" / "latest.png"
        path.parent.mkdir(parents=True, exist_ok=True)

    path.write_bytes(img_bytes)
    return {"path": str(path)}


async def get_state(client: Any, session_dir: Path, selector_map: dict[int, dict],
                    prev_indices: set[int] | None = None) -> dict:
    html_result = await client.send_raw("Runtime.evaluate", {
        "expression": "document.documentElement.outerHTML",
        "returnByValue": True,
    })
    html = html_result.get("result", {}).get("value", "")

    info_result = await client.send_raw("Runtime.evaluate", {
        "expression": "JSON.stringify({url: location.href, title: document.title, scrollY: Math.round(window.scrollY)})",
        "returnByValue": True,
    })
    info = json.loads(info_result.get("result", {}).get("value", "{}"))
    url = info.get("url", "")
    title = info.get("title", "")
    scroll_y = info.get("scrollY", 0)

    dom_text, new_map = dom_serialize(html, url, title, scroll_y, prev_indices)

    # Update in-place so caller sees new map
    selector_map.clear()
    selector_map.update(new_map)

    # Write to disk
    state_dir = session_dir / "state"
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / "dom.txt").write_text(dom_text)
    (state_dir / "dom_selector.json").write_text(json.dumps(new_map, indent=2))

    # Screenshot
    ss_result = await client.send_raw("Page.captureScreenshot", {"format": "png"})
    ss_data = ss_result.get("data", "")
    ss_path = state_dir / "latest.png"
    ss_path.write_bytes(base64.b64decode(ss_data))

    return {
        "dom_text": dom_text,
        "dom_file": str(state_dir / "dom.txt"),
        "screenshot": str(ss_path),
        "url": url,
        "title": title,
        "scroll_y": scroll_y,
    }


async def done(client: Any, params: dict, done_flag: dict) -> dict:
    text = params.get("text", "")
    success = params.get("success", True)
    done_flag["is_done"] = True
    done_flag["success"] = success
    done_flag["text"] = text
    return {"is_done": True, "success": success, "text": text}


async def wait(client: Any, params: dict) -> dict:
    seconds = min(int(params.get("seconds", 2)), 30)
    await asyncio.sleep(seconds)
    return {"waited_seconds": seconds}


async def search(client: Any, params: dict, session_dir: Path) -> dict:
    query = params.get("query", "")
    engine = params.get("engine", "duckduckgo")
    if engine == "duckduckgo":
        url = "https://duckduckgo.com/?q=" + urllib.parse.quote_plus(query)
    elif engine == "google":
        url = "https://www.google.com/search?q=" + urllib.parse.quote_plus(query)
    else:
        url = "https://duckduckgo.com/?q=" + urllib.parse.quote_plus(query)
    return await navigate(client, {"url": url}, session_dir)
