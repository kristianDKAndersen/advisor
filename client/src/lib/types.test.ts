import { describe, it, expect } from 'vitest';
import type {
  ChannelMessage,
  ResultBody,
  MessageType,
  Meta,
  SessionState,
  SynthesisRecord,
  SessionSummary,
  ActiveSession,
} from './types';

describe('ChannelMessage', () => {
  it('accepts all required fields with correct types', () => {
    const msg: ChannelMessage = {
      ts: 1_700_000_000,
      type: 'task',
      body: 'do something',
      from: 'advisor',
      seq: 1,
    };
    expect(typeof msg.ts).toBe('number');
    expect(typeof msg.seq).toBe('number');
    expect(typeof msg.from).toBe('string');
    expect(msg.type).toBe('task');
  });

  it('accepts object body', () => {
    const msg: ChannelMessage = {
      ts: 1_700_000_001,
      type: 'result',
      body: { summary: 'done', verdict: 'complete' },
      from: 'coder',
      seq: 2,
    };
    expect(typeof msg.body).toBe('object');
  });
});

describe('ResultBody', () => {
  it('verdict accepts complete', () => {
    const r: ResultBody = { verdict: 'complete', summary: 'all good', paths: [] };
    expect(r.verdict).toBe('complete');
  });

  it('verdict accepts partial', () => {
    const r: ResultBody = { verdict: 'partial' };
    expect(r.verdict).toBe('partial');
  });

  it('verdict accepts blocked', () => {
    const r: ResultBody = { verdict: 'blocked' };
    expect(r.verdict).toBe('blocked');
  });

  it('meta tokens are optional record', () => {
    const r: ResultBody = {
      verdict: 'complete',
      meta: { tokens: { input_tokens: 100, output_tokens: 50 }, tool_calls: 5 },
    };
    expect(r.meta?.tool_calls).toBe(5);
  });
});

describe('MessageType', () => {
  it('covers all seven variants', () => {
    const types: MessageType[] = [
      'task',
      'progress',
      'result',
      'guidance',
      'terminate',
      'question',
      'stalled',
    ];
    expect(types).toHaveLength(7);
  });
});

describe('Meta', () => {
  it('requires sid and agent', () => {
    const m: Meta = { sid: 'abc-123', agent: 'coder' };
    expect(m.sid).toBe('abc-123');
    expect(m.agent).toBe('coder');
  });
});

describe('SynthesisRecord', () => {
  it('material is yes or no literal', () => {
    const s: SynthesisRecord = {
      seq: 3,
      sid: 'xyz',
      established: 'types compile',
      gap: 'none',
      material: 'yes',
      next_action: 'ship',
    };
    expect(s.material).toBe('yes');
  });
});

describe('ActiveSession', () => {
  it('extends SessionSummary with lastTs and lastType', () => {
    const a: ActiveSession = {
      sid: 'sid-1',
      agent: 'advisor',
      count: 10,
      lastTs: 1_700_000_002,
      lastType: 'progress',
    };
    expect(a.lastTs).toBeTypeOf('number');
    expect(a.lastType).toBe('progress');
  });
});
