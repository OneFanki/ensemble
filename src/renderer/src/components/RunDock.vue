<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Copy, KeyRound, X } from "lucide-vue-next";
import { useWorkspaceStore } from "../stores/workspace";

const store = useWorkspaceStore();
const { t } = useI18n();

async function copyInstancePassword(instanceId: string, identityId?: string) {
  if (!identityId) return;
  const instance = store.instances.find((item) => item.id === instanceId);
  if (!instance) return;
  await store.copyPassword({ kind: "identity", id: identityId });
}
</script>

<template>
  <!--
    Live instances only. Scene launching lives in the scenes view and the rail is
    the single navigation surface, so this panel does not repeat either.
  -->
  <aside class="dock">
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
        <span class="run-name">{{ instance.label }}</span>
        <span class="run-mode mono" :class="instance.mode">
          {{ instance.mode === "cdp" ? "CDP" : "EXT" }}
        </span>
        <button
          class="run-btn"
          type="button"
          :aria-label="$t('app.copyPasswordFor', { label: instance.label })"
          :disabled="!instance.identityId"
          @click="copyInstancePassword(instance.id, instance.identityId)"
        >
          <Copy :size="11" />
        </button>
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
        {{ $t("app.noRunningIdentity") }}
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
  color: var(--red);
}

.running-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
  overflow-y: auto;
  min-height: 0;
  flex: 1 1 auto;
}

.run-row {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--line-soft);
  background: var(--surface);
  border-radius: var(--radius);
  padding: 7px 8px;
  font-size: 11.5px;
  min-width: 0;
}

.led {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--green);
  flex: 0 0 5px;
  box-shadow: 0 0 6px color-mix(in srgb, var(--green) 60%, transparent);
}

.run-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.run-mode {
  margin-left: auto;
  font-size: 10px;
  color: var(--faint);
  border: 1px solid var(--line-soft);
  border-radius: 3px;
  padding: 2px 4px;
}

.run-mode.external {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 30%, var(--line));
}

.run-btn {
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  border-radius: 4px;
  color: var(--faint);
  flex: 0 0 18px;
}

.run-btn:hover {
  background: var(--surface-3);
  color: var(--text-secondary);
}

.empty {
  border: 1px dashed var(--line);
  border-radius: var(--radius);
  padding: 16px 10px;
  text-align: center;
  font-size: 11.5px;
  color: var(--faint);
}

.hint {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 8px;
  border: 1px dashed var(--line);
  border-radius: var(--radius);
  font-size: 11px;
  line-height: 1.55;
  color: var(--faint);
  flex: 0 0 auto;
}

.hint svg {
  flex: 0 0 12px;
  margin-top: 1px;
  color: var(--accent);
}

.dock-foot {
  display: flex;
  font-size: 10.5px;
  color: var(--faint);
  flex: 0 0 auto;
}

.dock-foot .right {
  margin-left: auto;
}

@media (max-width: 1180px) {
  .dock {
    display: none;
  }
}
</style>
