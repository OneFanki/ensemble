<script setup lang="ts">
import { computed } from "vue";
import { Copy, KeyRound, Play, Plus, Square, X } from "lucide-vue-next";
import { useWorkspaceStore } from "../stores/workspace";
import type { RoleColor } from "@shared/types";

const emit = defineEmits<{ newScene: [] }>();
const store = useWorkspaceStore();

const roleVar = (color: RoleColor) => `var(--role-${color})`;
const featuredScene = computed(() => store.environmentScenes[0]);

function identityName(identityId?: string): string {
  if (!identityId) return "干净会话";
  return store.identities.find((identity) => identity.id === identityId)?.name ?? "未知身份";
}

function identityColor(identityId?: string): string {
  const identity = store.identities.find((item) => item.id === identityId);
  return roleVar(identity?.color ?? "slate");
}

async function openProfile(instanceId: string, identityId?: string) {
  if (!identityId) return;
  const instance = store.instances.find((item) => item.id === instanceId);
  if (!instance) return;
  await store.copyPassword({ kind: "identity", id: identityId });
}
</script>

<template>
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
        <span class="run-mode mono" :class="instance.mode">{{ instance.mode === "cdp" ? "CDP" : "EXT" }}</span>
        <button
          class="run-btn"
          type="button"
          :aria-label="`复制 ${instance.label} 的密码`"
          :disabled="!instance.identityId"
          @click="openProfile(instance.id, instance.identityId)"
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
        没有运行中的身份，点击卡片即可启动。
      </div>
    </div>

    <div class="dock-sep"></div>

    <div v-if="featuredScene" class="scene-card">
      <div class="kicker mono">Scene 01</div>
      <div class="scene-name">{{ featuredScene.name }}</div>
      <div class="scene-sub mono">
        {{ featuredScene.identityIds.length }} 个身份 · 布局 {{ featuredScene.layout.replace("x", " × ") }}
      </div>
      <div class="scene-members">
        <span
          v-for="id in featuredScene.identityIds.slice(0, 6)"
          :key="id"
          class="mini-av"
          :style="{ background: identityColor(id) }"
          :title="identityName(id)"
        >
          {{ identityName(id).slice(0, 1) }}
        </span>
      </div>
      <button
        class="btn primary"
        type="button"
        :disabled="store.busy === 'launch'"
        @click="store.launchScene(featuredScene.id)"
      >
        <Play :size="12" />
        {{ $t("app.runScene") }}
      </button>
    </div>

    <div v-else class="scene-card empty-scene">
      <div class="scene-name">还没有场景</div>
      <div class="scene-sub">把常一起测的身份编排成一幕。</div>
      <button class="btn" type="button" @click="emit('newScene')">
        <Plus :size="12" />
        {{ $t("app.newScene") }}
      </button>
    </div>

    <div class="hint">
      <KeyRound :size="12" />
      <span>
        密码只保存在主进程，通过系统密钥环加密；自动填充不会写入日志。
      </span>
    </div>

    <div class="dock-foot mono">
      <span>{{ store.engines.length }} 个引擎</span>
      <span class="right">{{ store.instances.length }} 个实例</span>
    </div>
  </aside>
</template>

<style scoped>
.dock {
  border-left: 1px solid var(--line-soft);
  background: color-mix(in srgb, var(--bg) 92%, black);
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
  font-size: 9.5px;
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
  font-size: 10px;
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
  max-height: 40%;
  flex: 0 1 auto;
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
  font-size: 8.5px;
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
  font-size: 10.5px;
  color: var(--faint);
}

.dock-sep {
  height: 1px;
  background: var(--line-soft);
  flex: 0 0 auto;
}

.scene-card {
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: linear-gradient(160deg, var(--surface-2), var(--surface));
  padding: 11px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 0 0 auto;
}

.kicker {
  font-size: 8.5px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--accent);
}

.scene-name {
  font-size: 12.5px;
  font-weight: 500;
}

.scene-sub {
  font-size: 9.5px;
  color: var(--faint);
  line-height: 1.5;
}

.scene-members {
  display: flex;
  align-items: center;
  gap: 4px;
}

.mini-av {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 9px;
  font-weight: 500;
  color: var(--accent-foreground);
  border: 2px solid var(--surface);
}

.mini-av + .mini-av {
  margin-left: -9px;
}

.scene-card .btn,
.empty-scene .btn {
  width: 100%;
  justify-content: center;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: var(--radius);
  padding: 7px 10px;
  font-size: 11.5px;
  border: 1px solid var(--line);
  background: var(--surface-2);
  color: var(--text-secondary);
}

.btn.primary {
  background: linear-gradient(180deg, var(--accent-strong), color-mix(in srgb, var(--accent) 88%, black));
  border-color: color-mix(in srgb, var(--accent) 80%, black);
  color: var(--accent-foreground);
  font-weight: 500;
}

.hint {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 8px;
  border: 1px dashed var(--line);
  border-radius: var(--radius);
  font-size: 10px;
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
  margin-top: auto;
  display: flex;
  font-size: 9px;
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
