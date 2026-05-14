import type {
  SessionSummary,
  ActiveSession,
  ChannelMessage,
  Meta,
  SessionState,
  SynthesisRecord,
} from './types';

export async function listSessions(): Promise<SessionSummary[]> {
  const res = await fetch('/api/sessions');
  return res.json();
}

export async function listActive(): Promise<ActiveSession[]> {
  const res = await fetch('/api/active');
  return res.json();
}

export async function getMessages(sid: string): Promise<ChannelMessage[]> {
  const res = await fetch(`/api/sessions/${sid}/messages`);
  return res.json();
}

export async function getDetail(
  sid: string,
): Promise<{ meta: Meta | null; session: SessionState | null; synthesisRecords: SynthesisRecord[] }> {
  const res = await fetch(`/api/sessions/${sid}/detail`);
  return res.json();
}

export function connectSSE(
  sid: string,
  onMsg: (msgs: ChannelMessage[]) => void,
  onError?: (e: Event) => void,
): () => void {
  const es = new EventSource(`/events?sid=${sid}&after=0`);
  es.addEventListener('messages', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data);
      if (Array.isArray(data.msgs)) onMsg(data.msgs);
    } catch (e) {
      onError?.(e as unknown as Event);
    }
  });
  es.onerror = (e) => onError?.(e);
  return () => es.close();
}
