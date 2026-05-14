import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import App from './App.svelte';
import { dashboardStore } from './lib/store.svelte';

// jsdom does not implement ResizeObserver
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const flowRef = vi.hoisted(() => ({ onnodedragstop: null as ((...args: any[]) => void) | null }));

vi.mock('@xyflow/svelte', () => ({
  SvelteFlow: (_anchor: any, props: any) => { flowRef.onnodedragstop = props?.onnodedragstop ?? null; },
  Controls: () => {},
  Background: () => {},
  MiniMap: () => {},
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  dashboardStore.setSelected(null);
});

describe('App', () => {
  it('renders Advisor Dashboard title', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => [] }),
    );

    const { container } = render(App);
    await tick();

    expect(container.textContent).toContain('Advisor Dashboard');
  });

  it('reads localStorage advisor-canvas-positions on mount', async () => {
    const positions = { 'abc-123': { x: 42, y: 100 } };
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(JSON.stringify(positions));
    vi.spyOn(Storage.prototype, 'setItem');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));

    render(App);
    await tick();

    expect(getItemSpy).toHaveBeenCalledWith('advisor-canvas-positions');
  });

  it('saves node position to localStorage on nodedragstop', async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(null);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));

    render(App);
    await tick();

    const node = { id: 'sid-1', position: { x: 55, y: 77 } };
    flowRef.onnodedragstop?.({ targetNode: node, nodes: [node], event: {} });

    expect(setItemSpy).toHaveBeenCalledWith(
      'advisor-canvas-positions',
      JSON.stringify({ 'sid-1': { x: 55, y: 77 } }),
    );
  });

  it('renders MessageList panel when selectedSid is set', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
    const MockEventSource = vi.fn().mockImplementation(() => ({
      close: vi.fn(),
      addEventListener: vi.fn(),
    }));
    vi.stubGlobal('EventSource', MockEventSource);

    const { container } = render(App);
    await tick();

    dashboardStore.setSelected('test-sid-123');
    await tick();
    await tick();

    expect(container.querySelector('.panel')).not.toBeNull();
  });
});
