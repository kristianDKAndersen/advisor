#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// Pure functions (unit tested via term-mirror.test.js)
// ---------------------------------------------------------------------------

function parseJsonlDelta(buffer) {
  const nl = buffer.lastIndexOf('\n');
  if (nl === -1) return { records: [], remainder: buffer };
  const complete = buffer.slice(0, nl);
  const remainder = buffer.slice(nl + 1);
  const records = [];
  for (const line of complete.split('\n')) {
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch (e) {
      // skip malformed line
    }
  }
  return { records, remainder };
}

const IGNORED_TYPES = new Set([
  'queue-operation', 'attachment', 'last-prompt', 'ai-title', 'mode', 'permission-mode',
]);

function recordToMessage(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.type !== 'user' && record.type !== 'assistant') return null;
  if (IGNORED_TYPES.has(record.type)) return null;
  const message = record.message;
  if (!message) return null;
  const role = message.role || record.type;
  const content = message.content;
  const blocks = [];

  if (typeof content === 'string') {
    if (content.length) blocks.push({ kind: 'text', text: content });
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'text' && typeof item.text === 'string') {
        blocks.push({ kind: 'text', text: item.text });
      } else if (item.type === 'thinking' && typeof item.thinking === 'string') {
        blocks.push({ kind: 'thinking', text: item.thinking });
      } else if (item.type === 'tool_use') {
        blocks.push({ kind: 'tool_use', name: item.name, input: item.input });
      } else if (item.type === 'tool_result') {
        let text = item.content;
        if (Array.isArray(text)) {
          text = text.map((c) => (c && typeof c.text === 'string' ? c.text : JSON.stringify(c))).join('\n');
        } else if (typeof text !== 'string') {
          text = JSON.stringify(text);
        }
        blocks.push({ kind: 'tool_result', text });
      }
    }
  }

  if (blocks.length === 0) return null;
  return { role, blocks };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMarkdown(src) {
  let s = escapeHtml(src);
  s = s.replace(/```([\s\S]*?)```/g, (m, code) => `<pre><code>${code.replace(/^\n/, '')}</code></pre>`);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/^### (.*)$/gm, '<h3>$1</h3>');
  s = s.replace(/^## (.*)$/gm, '<h2>$1</h2>');
  s = s.replace(/^# (.*)$/gm, '<h1>$1</h1>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/(^|\n)- (.*)/g, '$1<li>$2</li>');
  s = s
    .split(/\n{2,}/)
    .map((p) => (p.startsWith('<pre>') || p.startsWith('<h') ? p : `<p>${p.replace(/\n/g, '<br>')}</p>`))
    .join('\n');
  return s;
}

function summarizeToolUse(name, input) {
  if (name === 'Bash' && input && typeof input.command === 'string') {
    return `Bash: ${input.command.split('\n')[0].slice(0, 120)}`;
  }
  if (input && typeof input === 'object') {
    return `${name}: ${JSON.stringify(input).slice(0, 100)}`;
  }
  return name || 'tool_use';
}

function blockHtml(block) {
  if (block.kind === 'text') {
    return `<div class="text">${renderMarkdown(block.text)}</div>`;
  }
  if (block.kind === 'thinking') {
    return `<details class="thinking"><summary>thinking</summary><pre class="mono">${escapeHtml(block.text)}</pre></details>`;
  }
  if (block.kind === 'tool_use') {
    const summary = summarizeToolUse(block.name, block.input);
    return `<details class="tool"><summary>${escapeHtml(summary)}</summary><pre class="mono">${escapeHtml(
      JSON.stringify(block.input, null, 2)
    )}</pre></details>`;
  }
  if (block.kind === 'tool_result') {
    return `<details class="tool-result"><summary>tool result</summary><pre class="mono">${escapeHtml(block.text)}</pre></details>`;
  }
  return '';
}

function messageHtml(msg) {
  const cls = msg.role === 'user' ? 'msg user' : 'msg assistant';
  const label = msg.role === 'user' ? 'You' : 'Claude';
  const inner = msg.blocks.map(blockHtml).join('\n');
  return `<div class="${cls}"><div class="role">${label}</div>${inner}</div>`;
}

module.exports = {
  parseJsonlDelta,
  recordToMessage,
  escapeHtml,
  renderMarkdown,
  summarizeToolUse,
  blockHtml,
  messageHtml,
};

// ---------------------------------------------------------------------------
// CLI / server (not unit tested; exercised via manual smoke test)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { port: 7879, session: 'mirror', attachExisting: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') args.port = parseInt(argv[++i], 10);
    else if (a === '--session') args.session = argv[++i];
    else if (a === '--attach-existing') args.attachExisting = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function findTranscriptPath(uuid) {
  const base = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(base)) return null;
  for (const dir of fs.readdirSync(base)) {
    const candidate = path.join(base, dir, `${uuid}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function waitForTranscript(uuid, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function tick() {
      const p = findTranscriptPath(uuid);
      if (p) return resolve(p);
      if (Date.now() - start > timeoutMs) return reject(new Error('transcript file did not appear in time'));
      setTimeout(tick, 300);
    })();
  });
}

function tmuxSessionExists(session) {
  try {
    execFileSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

function launchClaude(session, uuid) {
  if (!tmuxSessionExists(session)) {
    execFileSync('tmux', ['new-session', '-d', '-s', session, '-x', '220', '-y', '50']);
  }
  const cmd = `env -u CLAUDE_CODE_SESSION_ID -u SSE_PORT -u CHILD_SESSION -u ENTRYPOINT -u CLAUDECODE claude --session-id ${uuid}`;
  execFileSync('tmux', ['send-keys', '-t', session, '-l', '--', cmd]);
  execFileSync('tmux', ['send-keys', '-t', session, 'Enter']);
}

function sendInput(session, text) {
  const lines = String(text).split('\n');
  lines.forEach((line, i) => {
    execFileSync('tmux', ['send-keys', '-t', session, '-l', '--', line]);
    execFileSync('tmux', ['send-keys', '-t', session, i < lines.length - 1 ? 'S-Enter' : 'Enter']);
  });
}

function loadInitial(filePath) {
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    // file not there yet; tail will pick it up
  }
  const offset = Buffer.byteLength(raw, 'utf8');
  const withTrailingNl = raw.endsWith('\n') ? raw : raw + '\n';
  const { records } = parseJsonlDelta(withTrailingNl);
  const messages = [];
  for (const r of records) {
    const m = recordToMessage(r);
    if (m) messages.push(m);
  }
  return { messages, offset };
}

function startTail(filePath, initialOffset, onRecord) {
  let offset = initialOffset;
  let remainder = '';
  let busy = false;
  function poll() {
    if (busy) return;
    fs.stat(filePath, (err, stats) => {
      if (err || stats.size <= offset) return;
      busy = true;
      const stream = fs.createReadStream(filePath, { start: offset, end: stats.size - 1, encoding: 'utf8' });
      let chunk = '';
      stream.on('data', (d) => {
        chunk += d;
      });
      stream.on('end', () => {
        offset = stats.size;
        const { records, remainder: rem } = parseJsonlDelta(remainder + chunk);
        remainder = rem;
        for (const r of records) onRecord(r);
        busy = false;
      });
      stream.on('error', () => {
        busy = false;
      });
    });
  }
  const timer = setInterval(poll, 500);
  poll();
  return () => clearInterval(timer);
}

const PAGE_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>term-mirror</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 2rem 1rem 8rem;
    font: 16px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background: #f6f5f2; color: #1c1c1c;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #16161a; color: #e6e6e6; }
    .msg { background: #202024 !important; border-color: #2c2c31 !important; }
    .role { color: #9a9aa5 !important; }
    code, pre { background: #101013 !important; border-color: #2c2c31 !important; }
  }
  #log { max-width: 760px; margin: 0 auto; }
  .msg {
    background: #fff; border: 1px solid #e4e2dc; border-radius: 10px;
    padding: 1rem 1.25rem; margin-bottom: 1rem;
  }
  .msg.user { border-left: 3px solid #6b8afd; }
  .msg.assistant { border-left: 3px solid #7a7a7a; }
  .role { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #888; margin-bottom: 0.4rem; }
  .text p { margin: 0.6em 0; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #f0efe9; border: 1px solid #e4e2dc; border-radius: 4px; padding: 0.1em 0.35em; }
  pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #f0efe9; border: 1px solid #e4e2dc; border-radius: 8px; padding: 0.75em 1em; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
  pre code { border: none; background: none; padding: 0; }
  details { margin: 0.5em 0; }
  summary { cursor: pointer; color: #666; font-size: 0.9em; }
  #composer {
    position: fixed; left: 0; right: 0; bottom: 0;
    display: flex; gap: 0.5rem; padding: 1rem;
    background: rgba(246,245,242,0.92); backdrop-filter: blur(6px);
    border-top: 1px solid #e4e2dc;
  }
  @media (prefers-color-scheme: dark) {
    #composer { background: rgba(22,22,26,0.92); border-color: #2c2c31; }
    textarea { background: #202024; color: #e6e6e6; border-color: #2c2c31; }
  }
  #composer-inner { max-width: 760px; margin: 0 auto; display: flex; gap: 0.5rem; width: 100%; }
  textarea {
    flex: 1; resize: vertical; min-height: 2.5em; max-height: 12em;
    font: inherit; padding: 0.6em 0.8em; border-radius: 8px; border: 1px solid #ccc;
  }
  button {
    font: inherit; padding: 0 1.2em; border-radius: 8px; border: none;
    background: #6b8afd; color: #fff; cursor: pointer;
  }
  button:active { opacity: 0.8; }
</style>
</head>
<body>
<div id="log"></div>
<div id="composer">
  <div id="composer-inner">
    <textarea id="box" placeholder="Type a message... (Enter to send, Shift+Enter for newline)"></textarea>
    <button id="send">Send</button>
  </div>
</div>
<script>
  const log = document.getElementById('log');
  let stickToBottom = true;
  window.addEventListener('scroll', () => {
    stickToBottom = (window.innerHeight + window.scrollY) >= (document.body.offsetHeight - 40);
  });
  const es = new EventSource('/events');
  es.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    const div = document.createElement('div');
    div.innerHTML = data.html;
    log.appendChild(div.firstElementChild);
    if (stickToBottom) window.scrollTo(0, document.body.scrollHeight);
  };
  const box = document.getElementById('box');
  const sendBtn = document.getElementById('send');
  function send() {
    const text = box.value;
    if (!text.trim()) return;
    box.value = '';
    fetch('/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  }
  sendBtn.addEventListener('click', send);
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
</script>
</body>
</html>`;

const HELP_TEXT = `term-mirror.js - readable browser mirror + input for a live Claude Code session

Usage: node term-mirror.js [options]

Options:
  --port <n>              HTTP port (default 7879)
  --session <name>        tmux session name to launch/use (default "mirror")
  --attach-existing <uuid> bind to an already-running "claude --session-id <uuid>" instead of launching one
  --help                  show this help

On start (unless --attach-existing is given) this launches:
  claude --session-id <generated-uuid>
inside tmux session "mirror". Attach directly with:
  tmux attach -t mirror
`;

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP_TEXT);
    return;
  }

  (async () => {
    let uuid = args.attachExisting;
    if (!uuid) {
      uuid = crypto.randomUUID();
      console.log(`Launching claude --session-id ${uuid} in tmux session "${args.session}"...`);
      launchClaude(args.session, uuid);
    } else {
      console.log(`Attaching to existing session uuid ${uuid} (tmux session "${args.session}")`);
    }

    const transcriptPath = await waitForTranscript(uuid, 30000);
    console.log(`Transcript file: ${transcriptPath}`);

    const { messages: initialMessages, offset } = loadInitial(transcriptPath);
    const log = initialMessages.slice();
    const clients = new Set();

    function broadcast(msg) {
      log.push(msg);
      const payload = `data: ${JSON.stringify({ html: messageHtml(msg) })}\n\n`;
      for (const res of clients) res.write(payload);
    }

    startTail(transcriptPath, offset, (record) => {
      const msg = recordToMessage(record);
      if (msg) broadcast(msg);
    });

    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGE_HTML);
        return;
      }
      if (req.method === 'GET' && req.url === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        for (const msg of log) {
          res.write(`data: ${JSON.stringify({ html: messageHtml(msg) })}\n\n`);
        }
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'POST' && req.url === '/input') {
        let body = '';
        req.on('data', (c) => {
          body += c;
          if (body.length > 1e6) req.destroy();
        });
        req.on('end', () => {
          try {
            const { text } = JSON.parse(body || '{}');
            if (typeof text !== 'string' || !text.length) {
              res.writeHead(400);
              res.end('missing text');
              return;
            }
            sendInput(args.session, text);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.writeHead(400);
            res.end('bad request');
          }
        });
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });

    server.listen(args.port, '127.0.0.1', () => {
      console.log(`\nterm-mirror running:`);
      console.log(`  Browser:      http://localhost:${args.port}`);
      console.log(`  VS Code term: tmux attach -t ${args.session}`);
      console.log(`  (claude now runs inside that tmux session, not directly in your terminal)\n`);
    });
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

if (require.main === module) main();
