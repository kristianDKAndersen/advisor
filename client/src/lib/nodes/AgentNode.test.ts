import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import AgentNode from './AgentNode.svelte';
import type { MessageType } from '../types';

vi.mock('@xyflow/svelte', () => ({
  Handle: function Handle() {},
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
}));

afterEach(cleanup);

const baseData = {
  sid: '1234567890123456',
  agent: 'planner',
  lastType: 'progress' as MessageType,
  lastTs: Math.floor(Date.now() / 1000) - 180,
  lastBodyPreview: 'doing things',
  tier: 'fact',
};

// jsdom normalizes hex to rgb; provide expected rgb strings for color assertions
const COLORS: Record<string, string> = {
  task: 'rgb(59, 130, 246)',
  progress: 'rgb(245, 158, 11)',
  result: 'rgb(34, 197, 94)',
  guidance: 'rgb(249, 115, 22)',
  terminate: 'rgb(239, 68, 68)',
  question: 'rgb(168, 85, 247)',
  stalled: 'rgb(107, 114, 128)',
};

function getBadgeDotStyle(container: HTMLElement): string {
  return container.querySelector('.badge-dot')?.getAttribute('style') ?? '';
}

describe('AgentNode', () => {
  it('renders agent name', () => {
    const { getByText } = render(AgentNode, { data: baseData, id: 'test-node' });
    expect(getByText('planner')).toBeTruthy();
  });

  it('truncates sid to last 12 chars', () => {
    // '1234567890123456'.slice(-12) === '567890123456'
    const { container } = render(AgentNode, { data: baseData, id: 'test-node' });
    const sid = container.querySelector('.sid')?.textContent ?? '';
    expect(sid).toBe('...567890123456');
  });

  it('renders relative time as 3m ago', () => {
    const { container } = render(AgentNode, { data: baseData, id: 'test-node' });
    const relTime = container.querySelector('.rel-time')?.textContent ?? '';
    expect(relTime).toBe('3m ago');
  });

  it('renders badge label matching lastType', () => {
    const { container } = render(AgentNode, { data: baseData, id: 'test-node' });
    const label = container.querySelector('.badge-label')?.textContent ?? '';
    expect(label).toBe('progress');
  });

  it('renders tier label', () => {
    const { container } = render(AgentNode, { data: baseData, id: 'test-node' });
    const tier = container.querySelector('.tier')?.textContent ?? '';
    expect(tier).toBe('fact');
  });

  it('uses different badge colors per MessageType', () => {
    const { container: c1 } = render(AgentNode, {
      data: { ...baseData, lastType: 'progress' as MessageType },
      id: 'n1',
    });
    const style1 = getBadgeDotStyle(c1);
    cleanup();
    const { container: c2 } = render(AgentNode, {
      data: { ...baseData, lastType: 'result' as MessageType },
      id: 'n2',
    });
    const style2 = getBadgeDotStyle(c2);
    expect(style1).not.toBe(style2);
    expect(style1).toContain(COLORS.progress);
    expect(style2).toContain(COLORS.result);
  });

  it('uses terminate=red, task=blue, guidance=orange, question=purple, stalled=gray', () => {
    const types: MessageType[] = ['terminate', 'task', 'guidance', 'question', 'stalled'];
    for (const type of types) {
      const { container } = render(AgentNode, {
        data: { ...baseData, lastType: type },
        id: `node-${type}`,
      });
      const style = getBadgeDotStyle(container);
      expect(style).toContain(COLORS[type]);
      cleanup();
    }
  });
});
