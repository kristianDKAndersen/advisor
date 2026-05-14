import { describe, test, expect, vi, afterEach } from 'vitest';
import type { mount as MountFn, unmount as UnmountFn, flushSync as FlushFn, ComponentProps } from 'svelte';

// Direct path import to force Svelte client-mode mount in Vitest's jsdom environment.
// The 'svelte' package resolves to index-server.js without browser conditions applied,
// so we import the client entry directly. Types are cast via the type imports above.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no .d.ts for direct path; types come from 'svelte' type imports above
import { mount as _mount, unmount as _unmount, flushSync as _flushSync } from './client/node_modules/svelte/src/index-client.js';

const mount = _mount as typeof MountFn;
const unmount = _unmount as typeof UnmountFn;
const flushSync = _flushSync as typeof FlushFn;

vi.mock('@xyflow/svelte', () => {
  // Svelte 5 client-mode component stub: receives (anchor, props) and inserts
  // resize-control divs before the anchor when isVisible=true.
  function NodeResizer(anchor: Comment, props: { isVisible?: boolean; [k: string]: unknown }) {
    if (props.isVisible && anchor?.parentNode) {
      const el = document.createElement('div');
      el.className = 'svelte-flow__resize-control';
      anchor.parentNode.insertBefore(el, anchor);
    }
    return {};
  }
  return { NodeResizer };
});

import CategoryNode from './CategoryNode.svelte';

function renderNode(props: ComponentProps<typeof CategoryNode>) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(CategoryNode, { target, props });
  flushSync();
  return {
    target,
    cleanup: () => {
      unmount(component);
      document.body.removeChild(target);
    },
  };
}

afterEach(() => {
  // Clean up any leftover nodes if a test forgot to call cleanup.
  document.body.innerHTML = '';
});

describe('CategoryNode', () => {
  test('renders label text', () => {
    const { target, cleanup } = renderNode({ data: { label: 'Frontend Team', color: '#3b82f6' } });
    expect(target.textContent).toContain('Frontend Team');
    cleanup();
  });

  test('applies data.color to border-top color', () => {
    const { target, cleanup } = renderNode({ data: { label: 'Frontend Team', color: '#3b82f6' } });
    const node = target.querySelector('.category-node') as HTMLElement;
    // jsdom normalizes #3b82f6 → rgb(59, 130, 246)
    expect(node.style.borderTopColor).toMatch(/59.*130.*246/);
    cleanup();
  });

  test('applies rgba tint of data.color as background', () => {
    const { target, cleanup } = renderNode({ data: { label: 'Frontend Team', color: '#3b82f6' } });
    const node = target.querySelector('.category-node') as HTMLElement;
    // rgba(59, 130, 246, 0.06) for #3b82f6
    expect(node.style.backgroundColor).toMatch(/rgba?\(59[, ]+130[, ]+246/i);
    cleanup();
  });

  test('NodeResizer renders resize handles when selected=true', () => {
    const { target, cleanup } = renderNode({
      data: { label: 'Frontend Team', color: '#3b82f6' },
      selected: true,
    });
    const handles = target.querySelectorAll('.svelte-flow__resize-control');
    expect(handles.length).toBeGreaterThan(0);
    cleanup();
  });

  test('NodeResizer does not render handles when selected=false', () => {
    const { target, cleanup } = renderNode({
      data: { label: 'Frontend Team', color: '#3b82f6' },
      selected: false,
    });
    const handles = target.querySelectorAll('.svelte-flow__resize-control');
    expect(handles.length).toBe(0);
    cleanup();
  });

  test('default color #888 applied when data.color is omitted', () => {
    const { target, cleanup } = renderNode({ data: { label: 'No Color' } });
    const node = target.querySelector('.category-node') as HTMLElement;
    // #888 = rgb(136, 136, 136)
    expect(node.style.borderTopColor).toMatch(/136.*136.*136/);
    cleanup();
  });
});
