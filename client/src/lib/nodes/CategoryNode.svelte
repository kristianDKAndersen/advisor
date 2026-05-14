<script lang="ts">
  import { NodeResizer } from '@xyflow/svelte';

  interface CategoryNodeData {
    label: string;
    color?: string;
  }

  let { data, selected } = $props<{ data: CategoryNodeData; selected?: boolean }>();

  function hexToRgb(hex: string): string {
    const result = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (result) {
      return `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}`;
    }
    return '136, 136, 136';
  }

  const effectiveColor = $derived(data.color ?? '#888');
  const bgColor = $derived(`rgba(${hexToRgb(effectiveColor)}, 0.06)`);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="category-node"
  style="width: 100%; height: 100%; pointer-events: none; z-index: -1; box-sizing: border-box; position: relative; border-top: 2px solid {effectiveColor}; background-color: {bgColor};"
>
  <NodeResizer minWidth={200} minHeight={150} isVisible={selected} />
  <div
    class="category-header"
    style="pointer-events: auto; font-size: 14px; font-weight: 600; padding: 4px 8px; position: absolute; top: 0; left: 0;"
  >
    {data.label}
  </div>
</div>
