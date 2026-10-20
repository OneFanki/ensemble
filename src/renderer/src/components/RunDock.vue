<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { KeyRound, X } from "lucide-vue-next";
import { useWorkspaceStore } from "../stores/workspace";

const store = useWorkspaceStore();
const { t } = useI18n();
</script>

<template>
  <!--
    Live instances only. Launching lives in the identities and scenes views; this
    panel just reports what is open and lets you close it. The old "copy password"
    button was removed: copying belongs to the identity dialog, where the password
    it refers to is visible.
  -->
  <aside class="dock" data-tour="run-dock">
    <div class="dock-head">
      <span class="dock-title">{{ $t("app.running") }}</span>
      <span class="count mono">{{ store.instances.length }}</span>
      <button
        v-if="store.instances.length"
        type="button"
        class="close-all"
        @click="store.stopAll()"
      >
        {{ $t("app.closeAll") }}
      </button>
    </div>

    <div class="running-list">
      <div v-for="instance in store.instances" :key="instance.id" class="run-row">
        <span class="led"></span>
        <span class="run-name" :title="instance.label">{{ instance.label }}</span>
        <span class="run-mode mono" :class="instance.mode">
          {{ instance.mode === "cdp" ? "CDP" : "EXT" }}
        </span>
        <button
          class="run-btn"
          type="button"
          :aria-label="$t('app.stop')"
          @click="store.stopInstance(instance.id)"
        >
          <X :size="11" />
        </button>
      </div>

      <div v-if="!store.instances.length" class="empty">
        {{ t("app.noRunningIdentity") }}
      </div>
    </div>

    <div class="hint">
      <KeyRound :size="12" />
      <span>{{ $t("app.passwordSafetyNote") }}</span>
    </div>

    <div class="dock-foot mono">
      <span>{{ $t("app.instancesShort", { count: store.instances.length }) }}</span>
      <span class="right">{{ $t("app.enginesCount", { count: store.engines.length }) }}</span>
    </div>
  </aside>
</template>

<style scoped>
.dock {
  border-left: 1px solid var(--line-soft);
  background: var(--bg);
  padding: 15px 13px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  overflow: hidden;
}

.dock-head {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto;
}

.dock-title {
  font-size: 12px;
  font-weight: 500;
}

.count {
  font-size: 11px;
  color: var(--accent-foreground);
  background: var(--accent);
  border-radius: 999px;
  min-width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 5px;
}

.close-all {
  margin-left: auto;
  font-size: 11px;
  color: var(--faint);
}

.close-all:hover {
  color: var(--text-secondary);
}

.running-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.run-row {
  display: flex;
  align-items: center;
  gap: 7px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  background: var(--surface);
  padding: 6px 8px;
  min-width: 0;
}

.led {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--green);
  flex: 0 0 5px;
}

.run-name {
  font-size: 11.5px;
  color: var(--text-secondary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.run-mode {
  margin-left: auto;
  font-size: 9.5px;
  color: var(--faint);
}

.run-btn {
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border-radius: 4px;
  color: var(--faint);
  flex: 0 0 20px;
}

.run-btn:hover {
  color: var(--red);
  background: var(--surface-3);
}

.empty {
  border: 1px dashed var(--line);
  border-radius: var(--radius-sm);
  padding: 16px 12px;
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--faint);
  text-align: center;
}

.hint {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  border-top: 1px solid var(--line-soft);
  padding-top: 10px;
  font-size: 10px;
  line-height: 1.55;
  color: var(--faint);
  flex: 0 0 auto;
}

.hint svg {
  flex: 0 0 12px;
  margin-top: 1px;
}

.dock-foot {
  display: flex;
  gap: 10px;
  font-size: 10px;
  color: var(--faint);
  flex: 0 0 auto;
}

.dock-foot .right {
  margin-left: auto;
}
</style>
