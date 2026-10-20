<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Check, Globe, Pencil, Plus, Trash2, Waypoints } from "lucide-vue-next";
import { useWorkspaceStore } from "../stores/workspace";
import type { Environment } from "@shared/types";

const emit = defineEmits<{
  newEnvironment: [];
  editEnvironment: [id: string];
}>();

const store = useWorkspaceStore();
const { t } = useI18n();

const environments = computed(() => store.environments);

function identityCount(environment: Environment): number {
  return store.identities.filter((identity) => identity.environmentId === environment.id).length;
}

function sceneCount(environment: Environment): number {
  return store.scenes.filter((scene) => scene.environmentId === environment.id).length;
}

function engineLabel(environment: Environment): string {
  const engine =
    store.engines.find((item) => item.id === environment.defaultEngineId) ?? store.defaultEngine;
  if (!engine) return t("app.noBrowserFound");
  return `${engine.brand} ${engine.version ?? ""}`.trim();
}

function passwordSet(environment: Environment): boolean {
  return Boolean(store.credentials?.environment[environment.id]);
}

function isActive(environment: Environment): boolean {
  return store.activeEnvironment?.id === environment.id;
}

async function remove(environment: Environment) {
  if (!window.confirm(t("app.deleteEnvConfirm", { name: environment.name }))) return;
  await store.deleteEnvironment(environment.id);
}
</script>

<template>
  <section class="environments">
    <header class="head">
      <div class="head-copy">
        <h1>{{ $t("app.environments") }}</h1>
        <p class="head-note">{{ $t("app.environmentsSubtitle") }}</p>
      </div>
      <div class="head-actions">
        <button class="btn" type="button" @click="store.launchCleanSession()">
          <Globe :size="13" />
          {{ $t("app.cleanSessionNoEnv") }}
        </button>
        <button class="btn primary" type="button" @click="emit('newEnvironment')">
          <Plus :size="13" />
          {{ $t("app.newEnvironment") }}
        </button>
      </div>
    </header>

    <div v-if="!environments.length" class="empty">
      <Waypoints :size="22" />
      <p>{{ $t("app.emptyEnvironments") }}</p>
      <button class="btn primary" type="button" @click="emit('newEnvironment')">
        <Plus :size="13" />
        {{ $t("app.newEnvironment") }}
      </button>
    </div>

    <div v-else class="env-grid">
      <article
        v-for="environment in environments"
        :key="environment.id"
        class="env-card"
        :class="{ active: isActive(environment) }"
      >
        <div class="card-head">
          <span class="env-dot"></span>
          <h2 class="env-name">{{ environment.name }}</h2>
          <span v-if="isActive(environment)" class="active-chip">
            <Check :size="10" />
            {{ $t("app.currentEnvBadge") }}
          </span>
        </div>

        <p class="env-url mono" :title="environment.baseUrl">
          <Globe :size="11" />
          <span>{{ environment.baseUrl }}</span>
        </p>

        <dl class="env-meta">
          <div>
            <dt>{{ $t("app.identities") }}</dt>
            <dd class="mono">{{ identityCount(environment) }}</dd>
          </div>
          <div>
            <dt>{{ $t("app.scenes") }}</dt>
            <dd class="mono">{{ sceneCount(environment) }}</dd>
          </div>
          <div>
            <dt>{{ $t("app.defaultPassword") }}</dt>
            <dd>{{ passwordSet(environment) ? $t("app.passwordSet") : $t("app.passwordNotSet") }}</dd>
          </div>
          <div class="wide">
            <dt>{{ $t("app.defaultEngine") }}</dt>
            <dd>{{ engineLabel(environment) }}</dd>
          </div>
        </dl>

        <div class="card-actions">
          <button
            v-if="!isActive(environment)"
            class="btn small"
            type="button"
            @click="store.setActiveEnvironment(environment.id)"
          >
            {{ $t("app.switchHere") }}
          </button>
          <span v-else class="active-note">{{ $t("app.alreadyActive") }}</span>
          <button class="icon-btn" type="button" :aria-label="$t('app.edit')" @click="emit('editEnvironment', environment.id)">
            <Pencil :size="12" />
          </button>
          <button
            class="icon-btn danger"
            type="button"
            :aria-label="$t('app.delete')"
            @click="remove(environment)"
          >
            <Trash2 :size="12" />
          </button>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.environments {
  min-height: 0;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  padding: 18px 20px 16px;
  overflow-y: auto;
}

.head {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  flex: 0 0 auto;
}

/* Let the copy shrink so the buttons keep their intrinsic width; without this the
   flex item shrinks below the sum of both buttons and the inline-flex children
   wrap onto two lines at the default window size. */
.head-copy {
  min-width: 0;
  flex: 1 1 auto;
}

h1 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 500;
  letter-spacing: -0.015em;
}

.head-copy p {
  margin: 6px 0 0;
  font-size: 11.5px;
  color: var(--faint);
  line-height: 1.55;
  max-width: 640px;
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  margin-left: auto;
}

.env-grid {
  margin-top: 16px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
  align-content: start;
}

.env-card {
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-lg);
  background: var(--surface);
  padding: 14px 15px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.env-card.active {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--line));
  background: color-mix(in srgb, var(--accent) 4%, var(--surface));
}

.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.env-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  flex: 0 0 7px;
}

.env-name {
  margin: 0;
  font-size: 13.5px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.active-chip {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--accent);
  border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--line));
  border-radius: 999px;
  padding: 2px 7px 2px 5px;
  flex: 0 0 auto;
}

.env-url {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  color: var(--faint);
  min-width: 0;
}

.env-url span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.env-meta {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px 10px;
  border-top: 1px solid var(--line-soft);
  padding-top: 10px;
}

.env-meta div {
  min-width: 0;
}

.env-meta .wide {
  grid-column: 1 / -1;
}

.env-meta dt {
  font-size: 9.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--faint);
}

.env-meta dd {
  margin: 3px 0 0;
  font-size: 11.5px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  border-top: 1px solid var(--line-soft);
  padding-top: 10px;
}

.active-note {
  font-size: 10.5px;
  color: var(--faint);
}

.icon-btn {
  width: 28px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  color: var(--faint);
  border: 1px solid var(--line-soft);
  margin-left: auto;
}

.icon-btn + .icon-btn {
  margin-left: 0;
}

.icon-btn:hover {
  background: var(--surface-3);
  color: var(--text-secondary);
}

.icon-btn.danger:hover {
  color: var(--red);
  border-color: color-mix(in srgb, var(--red) 40%, var(--line));
}

.empty {
  margin-top: 28px;
  border: 1px dashed var(--line);
  border-radius: var(--radius-lg);
  padding: 40px 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--muted);
  font-size: 12px;
  text-align: center;
}

.empty p {
  margin: 0;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: var(--radius);
  padding: 7px 11px;
  font-size: 11.5px;
  border: 1px solid var(--line);
  background: var(--surface-2);
  color: var(--text-secondary);
  white-space: nowrap;
}

.btn:hover:not(:disabled) {
  background: var(--surface-3);
  border-color: color-mix(in srgb, var(--line) 70%, var(--accent));
}

.btn.small {
  padding: 5px 10px;
}

.btn.primary {
  background: linear-gradient(
    180deg,
    var(--accent-strong),
    color-mix(in srgb, var(--accent) 88%, black)
  );
  border-color: color-mix(in srgb, var(--accent) 80%, black);
  color: var(--accent-foreground);
  font-weight: 500;
}

/* Base `.btn:hover` also matches primary buttons and would turn them gray. */
.btn.primary:hover:not(:disabled) {
  background: linear-gradient(
    180deg,
    var(--accent-strong),
    color-mix(in srgb, var(--accent) 88%, black)
  );
  border-color: color-mix(in srgb, var(--accent) 80%, black);
  color: var(--accent-foreground);
  filter: brightness(1.07);
}
</style>
