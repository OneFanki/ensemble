<script setup lang="ts">
/**
 * List/table switch for a collection page.
 *
 * Two icon buttons in one recessed track rather than a dropdown: the choice is
 * binary and the current mode is drawn on screen, so a control that hides the
 * alternative behind a menu would cost a click to say what two buttons say.
 * The value is the page's setting (`sitesView` / `identitiesView`), not local
 * state, so a restart keeps the mode the user picked.
 */
import type { CollectionView } from "@shared/types";
import { List, Table2 } from "lucide-vue-next";
import IconButton from "./IconButton.vue";

defineProps<{ modelValue: CollectionView }>();

const emit = defineEmits<{
  "update:modelValue": [view: CollectionView];
}>();
</script>

<template>
  <div
    class="collection-view-toggle"
    data-view-toggle
    role="group"
    :aria-label="$t('app.collectionView')"
  >
    <IconButton
      :ariaLabel="$t('app.collectionViewList')"
      :active="modelValue === 'list'"
      data-collection-view="list"
      @click="emit('update:modelValue', 'list')"
    >
      <List :size="13" />
    </IconButton>
    <IconButton
      :ariaLabel="$t('app.collectionViewTable')"
      :active="modelValue === 'table'"
      data-collection-view="table"
      @click="emit('update:modelValue', 'table')"
    >
      <Table2 :size="13" />
    </IconButton>
  </div>
</template>

<style scoped>
.collection-view-toggle {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--seg-track);
}
</style>
