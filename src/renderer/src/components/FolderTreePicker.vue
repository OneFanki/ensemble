<script setup lang="ts">
import type { BookmarkFolder } from "@shared/types";
import { ChevronRight, Folder } from "lucide-vue-next";
import { computed, ref } from "vue";

/**
 * Picks one folder from the bookmark tree — or nothing at all.
 *
 * The empty value means the root option, whose meaning is the caller's to name:
 * "unfiled" for a bookmark's folder, "top level" for a folder's parent. That is
 * why the label is a prop rather than baked in.
 *
 * A flat rendered list rather than recursion: the visible rows are the walk of
 * the expanded tree, so one `v-for` draws any depth and the expand state is a
 * plain set instead of component-local flags spread across nested instances.
 */
const props = defineProps<{
  folders: BookmarkFolder[];
  /** `""` selects the root option; anything else is a folder id. */
  modelValue: string;
  rootLabel: string;
}>();

const emit = defineEmits<{ "update:modelValue": [value: string] }>();

interface Node {
  folder: BookmarkFolder;
  children: Node[];
}

const tree = computed<Node[]>(() => {
  const nodes = new Map<string, Node>();
  for (const folder of props.folders) nodes.set(folder.id, { folder, children: [] });
  const roots: Node[] = [];
  for (const node of nodes.values()) {
    const parent = node.folder.parentId ? nodes.get(node.folder.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
});

const expanded = ref<Set<string> | null>(null);

// Open by default, tracked as the set of folders the user collapsed: a picker
// that hides children behind expansion turns picking a leaf into a hunt, and a
// newly created folder must be visible without anyone updating the set. `null`
// means "nothing collapsed yet", so the whole tree shows at once.
function toggle(node: Node): void {
  const next = new Set(expanded.value ?? []);
  for (const { node: all } of rows.value) {
    if (all.children.length) next.add(all.folder.id);
  }
  if (next.has(node.folder.id)) next.delete(node.folder.id);
  else next.add(node.folder.id);
  expanded.value = next;
}

/** The chevron mirrors the same source of truth the row walk uses. */
function isOpen(node: Node): boolean {
  return !expanded.value || !expanded.value.has(node.folder.id);
}

const rows = computed(() => {
  const out: Array<{ node: Node; depth: number }> = [];
  const collapsed = expanded.value;
  const walk = (list: Node[], depth: number) => {
    for (const node of list) {
      out.push({ node, depth });
      if (node.children.length && (!collapsed || !collapsed.has(node.folder.id))) {
        walk(node.children, depth + 1);
      }
    }
  };
  walk(tree.value, 0);
  return out;
});
</script>

<template>
  <div class="tree-pick">
    <button
      type="button"
      class="pick-row"
      :class="{ on: modelValue === '' }"
      @click="emit('update:modelValue', '')"
    >
      <span class="pick-glyph"></span>
      <Folder :size="12" />
      <span class="pick-name">{{ rootLabel }}</span>
    </button>
    <button
      v-for="{ node, depth } in rows"
      :key="node.folder.id"
      type="button"
      class="pick-row"
      :class="{ on: modelValue === node.folder.id }"
      :style="{ paddingLeft: `${6 + depth * 14}px` }"
      @click="emit('update:modelValue', node.folder.id)"
    >
      <span class="pick-glyph"></span>
      <button
        v-if="node.children.length"
        type="button"
        class="pick-twist"
        :aria-label="node.folder.name"
        @click.stop="toggle(node)"
      >
        <ChevronRight :size="11" :class="{ open: isOpen(node) }" />
      </button>
      <Folder :size="12" />
      <span class="pick-name">{{ node.folder.name }}</span>
    </button>
  </div>
</template>

<style scoped>
.tree-pick {
  display: flex;
  flex-direction: column;
  max-height: 190px;
  overflow-y: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  padding: 3px;
}

.pick-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 7px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11.5px;
  text-align: left;
  min-width: 0;
}

.pick-row:hover {
  background: var(--surface-2);
  color: var(--text);
}

.pick-row.on {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--text);
}

/* Reserve the twist column even where there is no chevron, so names align. */
.pick-glyph {
  flex: 0 0 13px;
}

.pick-twist {
  display: grid;
  place-items: center;
  width: 13px;
  height: 13px;
  flex: 0 0 13px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--faint);
  padding: 0;
}

.pick-twist:hover {
  color: var(--text);
  background: var(--surface-3);
}

.pick-twist svg {
  transition: transform 0.12s ease;
}

.pick-twist svg.open {
  transform: rotate(90deg);
}

.pick-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
