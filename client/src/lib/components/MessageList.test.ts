import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import MessageList from './MessageList.svelte';
import type { ChannelMessage } from '../types';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mockDetail = {
  meta: { sid: 'test', agent: 'test-agent', goal: 'test goal' },
  session: null,
  synthesisRecords: [],
};

function makeFetch(messages: ChannelMessage[], detail = mockDetail) {
  return vi.fn().mockImplementation((url: string) => {
    if (url.endsWith('/messages')) {
      return Promise.resolve({ json: async () => messages });
    }
    return Promise.resolve({ json: async () => detail });
  });
}

describe('MessageList', () => {
  it('renders loading state while fetching', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    const { getByText } = render(MessageList, { sid: 'test' });
    await waitFor(() => expect(getByText('Loading...')).toBeTruthy());
  });

  it('renders message type badges after fetch resolves', async () => {
    const messages: ChannelMessage[] = [
      { ts: 1000, type: 'task', body: 'do x', from: 'advisor', seq: 1 },
      { ts: 1001, type: 'progress', body: 'doing x', from: 'coder', seq: 2 },
    ];
    vi.stubGlobal('fetch', makeFetch(messages));
    const { getAllByText } = render(MessageList, { sid: 'test' });
    await waitFor(() => {
      expect(getAllByText('task').length).toBeGreaterThan(0);
      expect(getAllByText('progress').length).toBeGreaterThan(0);
    });
  });

  it('Show more button toggles long body expansion', async () => {
    const longBody = 'a'.repeat(300);
    const messages: ChannelMessage[] = [
      { ts: 1000, type: 'task', body: longBody, from: 'advisor', seq: 1 },
    ];
    vi.stubGlobal('fetch', makeFetch(messages));
    const { getByText } = render(MessageList, { sid: 'test' });
    await waitFor(() => expect(getByText('Show more')).toBeTruthy());
    await fireEvent.click(getByText('Show more'));
    await waitFor(() => expect(getByText('Show less')).toBeTruthy());
  });

  it('clicking close button calls onClose callback', async () => {
    vi.stubGlobal('fetch', makeFetch([]));
    const onClose = vi.fn();
    const { getByText } = render(MessageList, { sid: 'test', onClose });
    const closeBtn = getByText('×');
    await fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
