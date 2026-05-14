export type MessageType =
  | 'task'
  | 'progress'
  | 'result'
  | 'guidance'
  | 'terminate'
  | 'question'
  | 'stalled';

export interface ChannelMessage {
  ts: number;
  type: MessageType;
  body: string | object;
  from: string;
  seq: number;
}

export interface ResultBody {
  summary?: string;
  paths?: string[];
  verdict?: 'complete' | 'partial' | 'blocked';
  meta?: {
    tokens?: Record<string, number>;
    tool_calls?: number;
    token_estimate?: number;
  };
}

export interface Meta {
  sid: string;
  agent: string;
  task?: string;
  goal?: string;
  outputDir?: string;
  repo?: string;
  created_ts?: number;
}

export interface SessionState {
  sid: string;
  user_prompt?: string;
  tier?: string;
  decomposition?: Array<{ role?: string; status?: string; sid?: string }>;
  decisions?: unknown[];
  next_action?: string;
}

export interface SynthesisRecord {
  seq: number;
  sid: string;
  established: string;
  gap: string;
  material: 'yes' | 'no';
  next_action: string;
  key_quotes?: string;
  ts_iso?: string;
}

export interface SessionSummary {
  sid: string;
  agent: string;
  goal?: string;
  count: number;
}

export interface ActiveSession extends SessionSummary {
  lastTs: number;
  lastType: MessageType;
}
