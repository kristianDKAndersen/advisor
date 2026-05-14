import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { listSessions, listActive, getMessages, getDetail, connectSSE } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeFetch(data: unknown) {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => data });
}

describe('listSessions', () => {
  it('calls /api/sessions and returns parsed JSON', async () => {
    const data = [{ sid: 'a', agent: 'coder', count: 2 }];
    vi.stubGlobal('fetch', makeFetch(data));
    const result = await listSessions();
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/sessions');
    expect(result).toEqual(data);
  });
});

describe('listActive', () => {
  it('calls /api/active and returns parsed JSON', async () => {
    const data = [{ sid: 'b', agent: 'advisor', count: 1, lastTs: 100, lastType: 'task' }];
    vi.stubGlobal('fetch', makeFetch(data));
    const result = await listActive();
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/active');
    expect(result).toEqual(data);
  });
});

describe('getMessages', () => {
  it('calls /api/sessions/:sid/messages and returns parsed JSON', async () => {
    const data = [{ ts: 1, type: 'task', body: 'do x', from: 'advisor', seq: 1 }];
    vi.stubGlobal('fetch', makeFetch(data));
    const result = await getMessages('sid-1');
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/sessions/sid-1/messages');
    expect(result).toEqual(data);
  });
});

describe('getDetail', () => {
  it('calls /api/sessions/:sid/detail and returns parsed JSON', async () => {
    const data = { meta: { sid: 'sid-1', agent: 'coder' }, session: null, synthesisRecords: [] };
    vi.stubGlobal('fetch', makeFetch(data));
    const result = await getDetail('sid-1');
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/sessions/sid-1/detail');
    expect(result).toEqual(data);
  });
});

describe('connectSSE', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'EventSource',
      vi.fn(function (this: any, url: string) {
        this.url = url;
        this.addEventListener = vi.fn();
        this.close = vi.fn();
        this.onerror = null;
      }),
    );
  });

  it('returns a function (unsubscriber)', () => {
    const unsub = connectSSE('sid-1', vi.fn());
    expect(typeof unsub).toBe('function');
  });

  it('unsubscriber does not throw', () => {
    const unsub = connectSSE('sid-1', vi.fn(), vi.fn());
    expect(() => unsub()).not.toThrow();
  });
});
