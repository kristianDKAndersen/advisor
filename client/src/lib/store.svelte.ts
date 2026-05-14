import { listSessions, listActive, connectSSE } from './api';
import type { SessionSummary, ActiveSession, ChannelMessage } from './types';

export const dashboardStore = (() => {
  let sessions = $state<SessionSummary[]>([]);
  let activeSessions = $state<ActiveSession[]>([]);
  let selectedSid = $state<string | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);

  const subscriptions = new Map<string, () => void>();
  const lastMessages = new Map<string, ChannelMessage[]>();

  return {
    get sessions() { return sessions; },
    get activeSessions() { return activeSessions; },
    get selectedSid() { return selectedSid; },
    get loading() { return loading; },
    get error() { return error; },

    lastMessageFor(sid: string): ChannelMessage[] {
      return lastMessages.get(sid) ?? [];
    },

    subscribe(sid: string) {
      if (subscriptions.has(sid)) return;
      const unsub = connectSSE(sid, (msgs) => {
        lastMessages.set(sid, msgs);
        if (msgs.length > 0) {
          const latest = msgs[msgs.length - 1];
          activeSessions = activeSessions.map(s =>
            s.sid === sid ? { ...s, lastType: latest.type, lastTs: latest.ts } : s
          );
        }
      });
      subscriptions.set(sid, unsub);
    },

    unsubscribe(sid: string) {
      const unsub = subscriptions.get(sid);
      if (unsub) {
        unsub();
        subscriptions.delete(sid);
      }
    },

    setSelected(sid: string | null) {
      selectedSid = sid;
    },

    async refresh() {
      loading = true;
      error = null;
      try {
        sessions = await listSessions();
        activeSessions = await listActive();
      } catch (err) {
        error = String((err as Error).message ?? err);
      } finally {
        loading = false;
      }
    },
  };
})();
