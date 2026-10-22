<script setup lang="ts">
import type { AuthBatchResult, Identity } from "@shared/types";
import { LogIn, RefreshCw } from "lucide-vue-next";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useWorkspaceStore } from "../stores/workspace";
import Modal from "./Modal.vue";

const emit = defineEmits<{ close: [] }>();

const store = useWorkspaceStore();
const { t } = useI18n();

/** Latest batch, so reasons ("not running", "no check path") stay visible. */
const report = ref<AuthBatchResult | null>(null);
const detailById = computed(() => {
  const map = new Map<string, string>();
  for (const result of report.value?.results ?? []) {
    if (result.detail) map.set(result.identityId, result.detail);
  }
  return map;
});

type Health = "signed-in" | "expired" | "unknown";

/**
 * Session state only. Whether a window is open is no longer a state of its own:
 * a check runs in the open window when there is one and in a hidden window
 * otherwise, so every identity can be checked either way.
 */
function healthOf(identity: Identity): Health {
  if (identity.status === "expired") return "expired";
  if (identity.status === "signed-in") return "signed-in";
  return "unknown";
}

const counts = computed(() => {
  const totals = { "signed-in": 0, expired: 0, unknown: 0 };
  for (const identity of store.siteIdentities) totals[healthOf(identity)] += 1;
  return totals;
});

/** Problems first: an expired session is what this panel exists to surface. */
const ordered = computed(() => {
  const rank: Record<Health, number> = { expired: 0, unknown: 1, "signed-in": 2 };
  return [...store.siteIdentities].sort((left, right) => {
    const delta = rank[healthOf(left)] - rank[healthOf(right)];
    return delta !== 0 ? delta : left.name.localeCompare(right.name);
  });
});

const busy = computed(() => store.busy === "auth-check-all" || store.busy === "auth-relogin");

async function checkAll() {
  const result = await store.checkAllAuth(store.activeSite?.id);
  if (result) report.value = result;
}

async function reloginAll() {
  // Deliberately no re-check here: a fill returns as soon as the form is
  // submitted, so checking immediately would mostly report the page that is
  // about to navigate away. The list keeps the previous verdict until the user
  // runs "Check all" again.
  await store.reloginExpired(store.activeSite?.id);
}

function label(health: Health): string {
  if (health === "signed-in") return t("app.healthSignedIn");
  if (health === "expired") return t("app.healthExpired");
  return t("app.healthUnknown");
}

function statusText(identity: Identity): string {
  const detail = detailById.value.get(identity.id);
  if (detail) return detail;
  if (identity.status === "expired") return t("app.healthExpiredNoCheck");
  if (identity.status === "signed-in") return t("app.healthSignedInNoCheck");
  return "—";
}
</script>

<template>
  <Modal
    :open="true"
    :title="$t('app.healthTitle')"
    :description="$t('app.healthDesc')"
    width="620px"
    @close="emit('close')"
  >
    <div class="counts">
      <span class="pill ok"><b class="mono">{{ counts['signed-in'] }}</b>{{ $t('app.healthSignedIn') }}</span>
      <span class="pill bad"><b class="mono">{{ counts.expired }}</b>{{ $t('app.healthExpired') }}</span>
      <span class="pill warn"><b class="mono">{{ counts.unknown }}</b>{{ $t('app.healthUnknown') }}</span>
    </div>

    <div class="health-list">
      <button
        v-for="identity in ordered"
        :key="identity.id"
        type="button"
        class="health-row"
        :class="healthOf(identity)"
        :style="{ '--role': `var(--role-${identity.color})` }"
        @click="store.instanceFor(identity.id) && store.focusInstance(identity.id)"
      >
        <span class="dot"></span>
        <span class="who">
          <span class="name">{{ identity.name }}</span>
          <span class="acct mono">{{ identity.username }} · {{ identity.role }}</span>
        </span>
        <!-- Explains how the next check will reach this identity, without adding
             a status of its own: no window is a detail, not a verdict. -->
        <span v-if="!store.instanceFor(identity.id)" class="nowin mono">
          {{ $t('app.healthHidden') }}
        </span>
        <span class="detail mono" :title="statusText(identity)">{{ statusText(identity) }}</span>
        <span class="state mono">{{ label(healthOf(identity)) }}</span>
      </button>

      <p v-if="!ordered.length" class="empty">{{ $t('app.empty') }}</p>
    </div>

    <p class="note">{{ $t('app.healthNote') }}</p>

    <template #footer>
      <button class="btn" type="button" :disabled="busy" @click="reloginAll">
        <LogIn :size="12" />
        {{ $t('app.healthRelogin') }}
      </button>
      <span class="spacer"></span>
      <button class="btn primary" type="button" :disabled="busy" @click="checkAll">
        <RefreshCw :size="12" :class="{ spinning: store.busy === 'auth-check-all' }" />
        {{ $t('app.healthCheckAll') }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.counts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--line-soft);
  border-radius: 999px;
  padding: 3px 9px;
  font-size: 10.5px;
  color: var(--faint);
}

.pill b {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text-secondary);
}

.pill.ok b {
  color: var(--green);
}

.pill.bad b {
  color: var(--red);
}

.health-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 340px;
  overflow-y: auto;
}

.health-row {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  padding: 7px 9px;
  text-align: left;
  min-width: 0;
}

.health-row:hover {
  border-color: var(--line);
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: 0 0 6px;
  background: var(--faint);
}

.health-row.signed-in .dot {
  background: var(--green);
}

.health-row.expired .dot {
  background: var(--red);
}

.health-row.unknown .dot {
  background: var(--amber);
}

.who {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.name {
  font-size: 11.5px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.acct {
  font-size: 9.5px;
  color: var(--faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.detail {
  margin-left: auto;
  font-size: 9.5px;
  color: var(--faint);
  max-width: 42%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 0 1 auto;
}

.nowin {
  flex: 0 0 auto;
  font-size: 9px;
  color: var(--faint);
  border: 1px solid var(--line-soft);
  border-radius: 4px;
  padding: 0 4px;
  line-height: 1.5;
}

.state {
  font-size: 9.5px;
  color: var(--faint);
  flex: 0 0 auto;
  min-width: 46px;
  text-align: right;
}

.health-row.expired .state {
  color: var(--red);
}

.health-row.unknown .state {
  color: var(--amber);
}

.empty {
  padding: 16px 0;
  text-align: center;
  font-size: 11px;
  color: var(--faint);
}

.note {
  margin: 12px 0 0;
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--faint);
}

.spacer {
  flex: 1 1 auto;
}

.spinning {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
