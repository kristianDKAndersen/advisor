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


async def navigate(client: Any, params: dict, session_dir: Path) -> dict:
    url = params.get("url", "")
    if not url.startswith(("http://", "https://", "about:", "file:")):
        url = "https://" + url
    result = await client.send_raw("Page.navigate", {"url": url})
    for _ in range(10):
        await asyncio.sleep(0.2)
        ready = await client.send_raw("Runtime.evaluate", {
            "expression": "document.readyState",
            "returnByValue": True,
        })
        if ready.get("result", {}).get("value") == "complete":
            break
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


# JS expression injected into Chrome to extract interactive elements and metadata
# in a single Runtime.evaluate round-trip. Mirrors dom_serializer.py output shape.
_GET_STATE_JS = r"""
(function(prevIndices) {
  var INTERACTIVE = {a:1,button:1,input:1,select:1,textarea:1};
  var BLOCK_TEXT = {h1:1,h2:1,h3:1,h4:1,h5:1,h6:1,p:1,li:1,td:1,th:1,caption:1,title:1};
  var SKIP = {script:1,style:1,noscript:1,head:1,meta:1,link:1};
  var KEEP_ATTRS = {href:1,src:1,type:1,placeholder:1,value:1,'aria-label':1,role:1,action:1,name:1};
  var MAX_CHARS = 24000;
  var url = location.href;
  var title = document.title;
  var scrollY = Math.round(window.scrollY);
  var lines = ['URL: '+url,'Title: '+title,'Scroll: '+scrollY+'px',''];
  var selectorMap = {};
  var counter = 0;
  var charCount = lines.reduce(function(s,l){return s+l.length+1;},0);
  var truncated = false;
  var prevSet = prevIndices !== null ? new Set(prevIndices) : null;

  function getXPath(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1) {
      var parent = node.parentNode;
      var idx = 1;
      if (parent) {
        var sibs = parent.childNodes;
        var count = 0;
        for (var i = 0; i < sibs.length; i++) {
          if (sibs[i].nodeType === 1 && sibs[i].tagName === node.tagName) {
            count++;
            if (sibs[i] === node) { idx = count; break; }
          }
        }
      }
      parts.unshift(node.tagName.toLowerCase()+'['+idx+']');
      node = parent;
    }
    return parts.length ? '/'+parts.join('/') : '/';
  }

  function appendLine(line) {
    var cost = line.length+1;
    if (charCount+cost > MAX_CHARS) {
      lines.push('--- TRUNCATED ('+charCount+' chars) ---');
      truncated = true;
      return false;
    }
    lines.push(line);
    charCount += cost;
    return true;
  }

  function getAttrStr(el) {
    var parts = [];
    var attrs = el.attributes;
    for (var i = 0; i < attrs.length; i++) {
      var k = attrs[i].name, v = attrs[i].value;
      if (KEEP_ATTRS[k] && v) parts.push(k+'="'+v+'"');
    }
    return parts.length ? ' '+parts.join(' ') : '';
  }

  function getAttrsObj(el) {
    var obj = {};
    var attrs = el.attributes;
    for (var i = 0; i < attrs.length; i++) {
      var k = attrs[i].name, v = attrs[i].value;
      if (KEEP_ATTRS[k] && v) obj[k] = v;
    }
    return obj;
  }

  function hasInteractive(el) {
    return el.querySelector('a,button,input,select,textarea') !== null;
  }

  function walk(node) {
    if (truncated || !node || node.nodeType !== 1) return;
    var tag = node.tagName.toLowerCase();
    if (SKIP[tag]) return;
    if (INTERACTIVE[tag]) {
      counter++;
      var idx = counter;
      var text = (node.textContent||'').replace(/\s+/g,' ').trim().slice(0,120);
      var isNew = prevSet !== null && !prevSet.has(idx);
      var prefix = isNew ? '*' : '';
      var line = prefix+'['+idx+']<'+tag+getAttrStr(node)+'>'+text+'</'+tag+'>';
      if (!appendLine(line)) return;
      selectorMap[idx] = {tag:tag,text:text,attrs:getAttrsObj(node),interactive:true,xpath:getXPath(node)};
      return;
    }
    if (BLOCK_TEXT[tag]) {
      if (!hasInteractive(node)) {
        var btext = (node.textContent||'').replace(/\s+/g,' ').trim().slice(0,200);
        if (btext) appendLine('<'+tag+'>'+btext+'</'+tag+'>');
        return;
      }
      var ch = node.childNodes;
      for (var i = 0; i < ch.length; i++) walk(ch[i]);
      return;
    }
    var ch = node.childNodes;
    for (var i = 0; i < ch.length; i++) walk(ch[i]);
  }

  walk(document.body || document.documentElement);
  return JSON.stringify({url:url,title:title,scrollY:scrollY,dom_text:lines.join('\n'),selector_map:selectorMap});
})(%s)
"""


async def get_state(client: Any, session_dir: Path, selector_map: dict[int, dict],
                    prev_indices: set[int] | None = None) -> dict:
    prev_js = "null" if prev_indices is None else json.dumps(sorted(prev_indices))
    result = await client.send_raw("Runtime.evaluate", {
        "expression": _GET_STATE_JS % prev_js,
        "returnByValue": True,
    })
    data = json.loads(result.get("result", {}).get("value", "{}"))
    url = data.get("url", "")
    title = data.get("title", "")
    scroll_y = data.get("scrollY", 0)
    dom_text = data.get("dom_text", "")
    new_map = {int(k): v for k, v in data.get("selector_map", {}).items()}
    selector_map.clear()
    selector_map.update(new_map)
    return {
        "dom_text": dom_text,
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
