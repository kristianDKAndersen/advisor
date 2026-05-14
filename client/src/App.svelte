<script lang="ts">
  import { SvelteFlow, Controls, Background, MiniMap, type Node, type Edge } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import AgentNode from './lib/nodes/AgentNode.svelte';
  import CategoryNode from './lib/nodes/CategoryNode.svelte';
  import MessageList from './lib/components/MessageList.svelte';
  import { dashboardStore } from './lib/store.svelte';
  import type { ActiveSession } from './lib/types';

  const nodeTypes = { agentNode: AgentNode, categoryNode: CategoryNode };
  let nodes = $state.raw<Node[]>([]);
  let edges = $state.raw<Edge[]>([]);
  let savedPositions = $state<Record<string, { x: number; y: number }>>({});

  $effect(() => {
    try {
      const raw = localStorage.getItem('advisor-canvas-positions');
      if (raw) savedPositions = JSON.parse(raw);
    } catch {}
  });

  $effect(() => {
    dashboardStore.refresh();
    const interval = setInterval(() => dashboardStore.refresh(), 5000);
    return () => clearInterval(interval);
  });

  $effect(() => {
    const active = dashboardStore.activeSessions;
    nodes = active.map((s: ActiveSession, i: number) => {
      const saved = savedPositions[s.sid];
      const position = saved ?? { x: 100 + (i % 4) * 280, y: 80 + Math.floor(i / 4) * 200 };
      return {
        id: s.sid,
        type: 'agentNode',
        position,
        data: {
          sid: s.sid,
          agent: s.agent,
          goal: s.goal,
          lastType: s.lastType,
          lastTs: s.lastTs,
          lastBodyPreview: ''
        }
      };
    });
  });

  $effect(() => {
    const sid = dashboardStore.selectedSid;
    if (!sid) return;
    dashboardStore.subscribe(sid);
    return () => dashboardStore.unsubscribe(sid);
  });

  function onNodeDragStop({ targetNode }: { targetNode: Node | null; nodes: Node[]; event: MouseEvent | TouchEvent }) {
    if (targetNode) {
      savedPositions = { ...savedPositions, [targetNode.id]: targetNode.position };
      try {
        localStorage.setItem('advisor-canvas-positions', JSON.stringify(savedPositions));
      } catch {}
    }
  }
</script>

<div class="app">
  <header class="app-header">
    <h1 class="title">Advisor Dashboard</h1>
    <div class="header-actions">
      <span class="live-indicator">
        <span class="dot" class:active={dashboardStore.activeSessions.length > 0}></span>
        {dashboardStore.activeSessions.length} active / {dashboardStore.sessions.length} total
      </span>
      <button class="refresh-btn" onclick={() => dashboardStore.refresh()}>
        Refresh
      </button>
    </div>
  </header>

  <div class="canvas-wrap">
    <SvelteFlow
      {nodes}
      {edges}
      {nodeTypes}
      fitView
      onnodeclick={({ node }) => dashboardStore.setSelected(node.id)}
      onnodedragstop={onNodeDragStop}
    >
      <Controls />
      <Background />
      <MiniMap />
    </SvelteFlow>

    {#if dashboardStore.selectedSid !== null}
      <aside class="detail-panel">
        <MessageList sid={dashboardStore.selectedSid} onClose={() => dashboardStore.setSelected(null)} />
      </aside>
    {/if}
  </div>
</div>

<style lang="raw">
  :root {
    --bg: #0b0d10;
    --fg: #e8eaed;
    --accent: #3b82f6;
  }

  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--bg);
    color: var(--fg);
  }

  .app-header {
    position: sticky;
    top: 0;
    z-index: 10;
    height: 48px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    background: #13161b;
    border-bottom: 1px solid #2a2d35;
    flex-shrink: 0;
  }

  .title {
    font-size: 16px;
    font-weight: 600;
    margin: 0;
    color: var(--fg);
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .live-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: #9ca3af;
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #4b5563;
    transition: background 0.3s;
  }

  .dot.active {
    background: #22c55e;
  }

  .refresh-btn {
    padding: 4px 12px;
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: 4px;
    font-size: 13px;
    cursor: pointer;
  }

  .refresh-btn:hover {
    background: #2563eb;
  }

  .canvas-wrap {
    flex: 1;
    position: relative;
    overflow: hidden;
  }

  .detail-panel {
    position: absolute;
    top: 0;
    right: 0;
    width: 360px;
    height: 100%;
    background: #13161b;
    border-left: 1px solid #2a2d35;
    z-index: 5;
    display: flex;
    flex-direction: column;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid #2a2d35;
  }

  .panel-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--fg);
  }

  .close-btn {
    background: none;
    border: none;
    color: #9ca3af;
    font-size: 18px;
    cursor: pointer;
    padding: 0 4px;
  }

  .panel-sid {
    padding: 12px 16px;
    font-family: monospace;
    font-size: 12px;
    color: #9ca3af;
    word-break: break-all;
  }
</style>
