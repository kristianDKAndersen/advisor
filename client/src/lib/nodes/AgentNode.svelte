<script lang="ts">
  import { Handle, Position } from '@xyflow/svelte';
  import type { MessageType } from '../types';

  export interface AgentNodeData {
    sid: string;
    agent: string;
    goal?: string;
    lastType?: MessageType;
    lastTs?: number;
    lastBodyPreview?: string;
    tier?: string;
  }

  interface Props {
    data: AgentNodeData;
    id: string;
    selected?: boolean;
  }

  let { data, id, selected = false }: Props = $props();

  const STATUS_COLORS: Record<string, string> = {
    task: '#3b82f6',
    progress: '#f59e0b',
    result: '#22c55e',
    guidance: '#f97316',
    terminate: '#ef4444',
    question: '#a855f7',
    stalled: '#6b7280',
  };

  function badgeColor(type?: MessageType): string {
    return (type ? STATUS_COLORS[type] : undefined) ?? '#6b7280';
  }

  function truncateSid(sid: string): string {
    return sid.length > 12 ? '...' + sid.slice(-12) : sid;
  }

  function truncatePreview(preview?: string): string {
    if (!preview) return '';
    return preview.length > 80 ? preview.slice(0, 80) + '…' : preview;
  }

  let relTime = $derived.by(() => {
    if (!data.lastTs) return '';
    const elapsed = Math.floor((Date.now() - data.lastTs * 1000) / 1000);
    if (elapsed < 60) return `${elapsed}s ago`;
    if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`;
    if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h ago`;
    return `${Math.floor(elapsed / 86400)}d ago`;
  });
</script>

<Handle type="target" position={Position.Left} />

<div class="agent-node" class:selected>
  <div class="header">
    <span class="agent-name">{data.agent}</span>
    <span class="badge">
      <span class="badge-dot" style="background: {badgeColor(data.lastType)};"></span>
      <span class="badge-label">{data.lastType ?? 'unknown'}</span>
    </span>
  </div>
  <div class="sid">{truncateSid(data.sid)}</div>
  {#if data.lastBodyPreview}
    <div class="preview">{truncatePreview(data.lastBodyPreview)}</div>
  {/if}
  <div class="footer">
    <span class="rel-time">{relTime}</span>
    {#if data.tier}
      <span class="tier">{data.tier}</span>
    {/if}
  </div>
</div>

<Handle type="source" position={Position.Right} />

<style lang="raw">
  .agent-node {
    min-width: 220px;
    max-width: 280px;
    background: #ffffff;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
    font-family: system-ui, sans-serif;
    padding: 10px 12px;
  }
  .agent-node.selected {
    border-color: #3b82f6;
    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.3);
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
  }
  .agent-name {
    font-weight: bold;
    font-size: 13px;
    color: #111827;
  }
  .badge {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .badge-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .badge-label {
    font-size: 11px;
    color: #6b7280;
  }
  .sid {
    font-family: monospace;
    font-size: 10px;
    color: #9ca3af;
    margin-bottom: 4px;
  }
  .preview {
    font-size: 11px;
    color: #374151;
    margin-bottom: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 10px;
    color: #9ca3af;
  }
  .tier {
    background: #f3f4f6;
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 10px;
    color: #6b7280;
  }
</style>
