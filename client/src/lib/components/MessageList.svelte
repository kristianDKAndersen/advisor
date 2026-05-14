<script lang="ts">
  import { getMessages, getDetail } from '../api';
  import type { ChannelMessage, MessageType, Meta, SessionState } from '../types';

  let { sid, onClose }: { sid: string; onClose?: () => void } = $props();

  let messages = $state<ChannelMessage[]>([]);
  let detail = $state<{ meta: Meta | null; session: SessionState | null; synthesisRecords: any[] } | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let expanded = $state<Set<number>>(new Set());

  const COLORS: Record<string, string> = {
    task: '#3b82f6',
    progress: '#f59e0b',
    result: '#10b981',
    guidance: '#f97316',
    terminate: '#ef4444',
    question: '#a855f7',
    stalled: '#6b7280',
  };

  const VERDICT_COLORS: Record<string, string> = {
    complete: '#10b981',
    partial: '#f59e0b',
    blocked: '#ef4444',
  };

  function badgeColor(type: MessageType): string {
    return COLORS[type] ?? '#6b7280';
  }

  function relTime(ts: number): string {
    const elapsed = Math.floor((Date.now() - ts * 1000) / 1000);
    if (elapsed < 60) return `${elapsed}s ago`;
    if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`;
    if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h ago`;
    return `${Math.floor(elapsed / 86400)}d ago`;
  }

  function bodyText(msg: ChannelMessage): string {
    if (typeof msg.body === 'object') return JSON.stringify(msg.body, null, 2);
    return msg.body;
  }

  interface ParsedResult {
    summary?: string;
    verdict?: string;
    paths?: string[];
  }

  function parseResultBody(body: string | object): ParsedResult | null {
    try {
      const parsed: ParsedResult = typeof body === 'string' ? JSON.parse(body) : (body as ParsedResult);
      if (parsed && (parsed.summary !== undefined || parsed.verdict !== undefined || parsed.paths !== undefined)) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  function toggleExpand(seq: number) {
    const next = new Set(expanded);
    if (next.has(seq)) {
      next.delete(seq);
    } else {
      next.add(seq);
    }
    expanded = next;
  }

  async function load(sidVal: string) {
    loading = true;
    error = null;
    try {
      const [msgs, det] = await Promise.all([getMessages(sidVal), getDetail(sidVal)]);
      messages = msgs;
      detail = det;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load';
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    load(sid);
  });
</script>

<div class="panel">
  <div class="panel-header">
    <div class="header-info">
      <span class="agent">{detail?.meta?.agent ?? ''}</span>
      {#if detail?.meta?.goal}
        <span class="goal">{detail.meta.goal}</span>
      {/if}
    </div>
    <button class="close-btn" onclick={() => onClose?.()}>×</button>
  </div>

  {#if loading}
    <div class="loading">Loading...</div>
  {:else if error}
    <div class="error">{error}</div>
  {:else}
    <div class="messages">
      {#each messages as msg (msg.seq)}
        {@const isResult = msg.type === 'result'}
        {@const parsed = isResult ? parseResultBody(msg.body) : null}
        {@const text = bodyText(msg)}
        {@const isLong = text.length > 200}
        {@const isExpanded = expanded.has(msg.seq)}

        <div class="message-card">
          <div class="message-meta">
            <span class="badge">
              <span class="badge-dot" style="background: {badgeColor(msg.type)};"></span>
              <span class="badge-label">{msg.type}</span>
            </span>
            <span class="rel-time">{relTime(msg.ts)}</span>
          </div>

          {#if parsed}
            <div class="result-body">
              {#if parsed.summary !== undefined}
                <div class="result-summary">{parsed.summary}</div>
              {/if}
              {#if parsed.verdict !== undefined}
                <div class="result-verdict" style="color: {VERDICT_COLORS[parsed.verdict] ?? '#6b7280'};">
                  {parsed.verdict}
                </div>
              {/if}
              {#if parsed.paths && parsed.paths.length > 0}
                <div class="result-paths">
                  {#each parsed.paths as path}
                    <button
                      class="path"
                      onclick={() => navigator.clipboard?.writeText(path).catch(() => {})}
                    ><code>{path}</code></button>
                  {/each}
                </div>
              {/if}
            </div>
          {:else}
            <pre class="body-text">{isExpanded ? text : text.slice(0, 200)}{!isExpanded && isLong ? '...' : ''}</pre>
            {#if isLong}
              <button class="show-more" onclick={() => toggleExpand(msg.seq)}>
                {isExpanded ? 'Show less' : 'Show more'}
              </button>
            {/if}
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style lang="raw">
  .panel {
    background: var(--bg-panel, #14181d);
    border-left: 1px solid var(--border, #2a2f37);
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .panel-header {
    position: sticky;
    top: 0;
    background: var(--bg-panel, #14181d);
    border-bottom: 1px solid var(--border, #2a2f37);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 12px 16px;
    z-index: 1;
    flex-shrink: 0;
  }

  .header-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .agent {
    font-weight: 600;
    font-size: 14px;
    color: #e5e7eb;
  }

  .goal {
    font-size: 11px;
    color: #9ca3af;
  }

  .close-btn {
    background: none;
    border: none;
    color: #9ca3af;
    cursor: pointer;
    font-size: 20px;
    line-height: 1;
    padding: 0 4px;
  }

  .close-btn:hover {
    color: #e5e7eb;
  }

  .loading {
    padding: 24px 16px;
    color: #9ca3af;
    font-size: 14px;
  }

  .error {
    padding: 16px;
    color: #ef4444;
    font-size: 13px;
  }

  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .message-card {
    background: #1a1f27;
    border: 1px solid var(--border, #2a2f37);
    border-radius: 6px;
    padding: 10px 12px;
  }

  .message-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }

  .badge {
    display: flex;
    align-items: center;
    gap: 5px;
  }

  .badge-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .badge-label {
    font-size: 12px;
    color: #d1d5db;
    font-weight: 500;
  }

  .rel-time {
    font-size: 11px;
    color: #6b7280;
  }

  .body-text {
    font-family: ui-monospace, monospace;
    font-size: 12px;
    color: #d1d5db;
    white-space: pre-wrap;
    margin: 0;
    word-break: break-all;
  }

  .show-more {
    background: none;
    border: none;
    color: #60a5fa;
    cursor: pointer;
    font-size: 12px;
    padding: 4px 0;
    margin-top: 4px;
    display: block;
  }

  .result-body {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .result-summary {
    font-size: 13px;
    color: #d1d5db;
  }

  .result-verdict {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
  }

  .result-paths {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-top: 4px;
  }

  .path {
    font-family: ui-monospace, monospace;
    font-size: 11px;
    color: #60a5fa;
    cursor: pointer;
    padding: 2px 6px;
    background: #0f1318;
    border: none;
    border-radius: 3px;
    display: block;
    word-break: break-all;
    text-align: left;
  }

  .path:hover {
    background: #1a2030;
  }

  .path code {
    font-family: inherit;
    font-size: inherit;
    color: inherit;
  }
</style>
