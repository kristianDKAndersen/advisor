import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { dashboardStore } from './store.svelte';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dashboardStore', () => {
  it('exposes array sessions and activeSessions', () => {
    expect(Array.isArray(dashboardStore.sessions)).toBe(true);
    expect(Array.isArray(dashboardStore.activeSessions)).toBe(true);
  });

  it('refresh() updates sessions and activeSessions on success', async () => {
    const sessions = [{ sid: 'sess-1', agent: 'coder', count: 3 }];
    const active = [
      { sid: 'sess-1', agent: 'coder', count: 3, lastTs: 999, lastType: 'result' as const },
    ];

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => sessions })
        .mockResolvedValueOnce({ ok: true, json: async () => active }),
    );

    await dashboardStore.refresh();

    expect(dashboardStore.sessions).toEqual(sessions);
    expect(dashboardStore.activeSessions).toEqual(active);
    expect(dashboardStore.loading).toBe(false);
    expect(dashboardStore.error).toBe(null);
  });

  it('refresh() sets error string on fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

    await dashboardStore.refresh();

    expect(dashboardStore.error).toBe('network error');
    expect(dashboardStore.loading).toBe(false);
  });

  it('setSelected() updates selectedSid', () => {
    dashboardStore.setSelected('my-sid');
    expect(dashboardStore.selectedSid).toBe('my-sid');
    dashboardStore.setSelected(null);
    expect(dashboardStore.selectedSid).toBe(null);
  });
});

describe('SSE integration', () => {
  const sid = 'sse-test-sid';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let MockEventSource: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    MockEventSource = vi.fn(function (this: any, url: string) {
      this.url = url;
      this.addEventListener = vi.fn((evt: string, cb: any) => { this._cb = cb; });
      this.close = vi.fn();
    });
    vi.stubGlobal('EventSource', MockEventSource);
  });

  afterEach(() => {
    dashboardStore.unsubscribe(sid);
  });

  it('subscribe opens EventSource with URL containing /events?sid=<sid>&after=0', () => {
    dashboardStore.subscribe(sid);
    expect(MockEventSource).toHaveBeenCalledOnce();
    const instance = MockEventSource.mock.instances[0] as any;
    expect(instance.url).toContain(`/events?sid=${sid}&after=0`);
  });

  it('incoming messages update lastMessageFor and activeSessions lastType/lastTs', async () => {
    const active = [{ sid, agent: 'coder', count: 3, lastTs: 0, lastType: 'progress' as const }];
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => [] })
        .mockResolvedValueOnce({ ok: true, json: async () => active }),
    );
    await dashboardStore.refresh();

    dashboardStore.subscribe(sid);
    const instance = MockEventSource.mock.instances[0] as any;

    const msg = { ts: 1, type: 'result' as const, body: '', from: 'x', seq: 9 };
    instance._cb({ data: JSON.stringify({ msgs: [msg] }) });

    expect(dashboardStore.lastMessageFor(sid)).toEqual([msg]);
    const session = dashboardStore.activeSessions.find((s) => s.sid === sid);
    expect(session?.lastType).toBe('result');
    expect(session?.lastTs).toBe(1);
  });

  it('unsubscribe calls close on the EventSource', () => {
    dashboardStore.subscribe(sid);
    const instance = MockEventSource.mock.instances[0] as any;
    dashboardStore.unsubscribe(sid);
    expect(instance.close).toHaveBeenCalledOnce();
  });
});
