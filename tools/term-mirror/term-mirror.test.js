import { test, expect } from "bun:test";
import { parseJsonlDelta, recordToMessage, escapeHtml, renderMarkdown } from "./term-mirror.js";

test("parseJsonlDelta: handles partial trailing line", () => {
  const buf = '{"a":1}\n{"a":2}\n{"a":3';
  const { records, remainder } = parseJsonlDelta(buf);
  expect(records).toEqual([{ a: 1 }, { a: 2 }]);
  expect(remainder).toBe('{"a":3');
});

test("parseJsonlDelta: no trailing newline at all returns everything as remainder", () => {
  const { records, remainder } = parseJsonlDelta('{"a":1}');
  expect(records).toEqual([]);
  expect(remainder).toBe('{"a":1}');
});

test("parseJsonlDelta: skips blank lines and malformed JSON", () => {
  const buf = '{"a":1}\n\nnot-json\n{"a":2}\n';
  const { records, remainder } = parseJsonlDelta(buf);
  expect(records).toEqual([{ a: 1 }, { a: 2 }]);
  expect(remainder).toBe('');
});

test("recordToMessage: user string content", () => {
  const rec = { type: "user", message: { role: "user", content: "hello" } };
  expect(recordToMessage(rec)).toEqual({ role: "user", blocks: [{ kind: "text", text: "hello" }] });
});

test("recordToMessage: user tool_result content", () => {
  const rec = { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } };
  expect(recordToMessage(rec)).toEqual({ role: "user", blocks: [{ kind: "tool_result", text: "ok" }] });
});

test("recordToMessage: assistant text block", () => {
  const rec = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi there" }] } };
  expect(recordToMessage(rec)).toEqual({ role: "assistant", blocks: [{ kind: "text", text: "hi there" }] });
});

test("recordToMessage: assistant thinking block", () => {
  const rec = { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "pondering" }] } };
  expect(recordToMessage(rec)).toEqual({ role: "assistant", blocks: [{ kind: "thinking", text: "pondering" }] });
});

test("recordToMessage: assistant tool_use block", () => {
  const rec = {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "ls -la" }, id: "abc" }] },
  };
  expect(recordToMessage(rec)).toEqual({
    role: "assistant",
    blocks: [{ kind: "tool_use", name: "Bash", input: { command: "ls -la" } }],
  });
});

for (const t of ["queue-operation", "attachment", "last-prompt", "ai-title", "mode", "permission-mode"]) {
  test(`recordToMessage: ignores metadata type ${t}`, () => {
    expect(recordToMessage({ type: t })).toBeNull();
  });
}

test("recordToMessage: returns null for unknown record type", () => {
  expect(recordToMessage({ type: "system" })).toBeNull();
});

test("renderMarkdown: escapes HTML before applying markdown", () => {
  const out = renderMarkdown("<script>alert(1)</script> **bold**");
  expect(out).not.toContain("<script>");
  expect(out).toContain("&lt;script&gt;");
  expect(out).toContain("<strong>bold</strong>");
});

test("renderMarkdown: renders inline code and fenced code", () => {
  const out = renderMarkdown("use `foo()` then:\n```\nconst x = 1;\n```");
  expect(out).toContain("<code>foo()</code>");
  expect(out).toContain("<pre><code>");
});

test("escapeHtml: escapes angle brackets and ampersands", () => {
  expect(escapeHtml('<a href="x">&y</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;y&lt;/a&gt;");
});
