<script setup lang="ts">
import type { AppMessageView, LoginCaptureNotice, MessageKind } from "@shared/types";
import {
  Bot,
  CircleAlert,
  CircleCheck,
  Globe,
  Info,
  KeyRound,
  TriangleAlert,
  Trash2,
  X,
} from "lucide-vue-next";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useConfirmStore } from "../stores/confirm";
import { useEmbeddedStore } from "../stores/embedded";
import { useWorkspaceStore } from "../stores/workspace";
import PageHeader from "./ui/PageHeader.vue";

/**
 * The message centre.
 *
 * One list for three things that used to have no home in common: a login that
 * wanted to be saved, an account that failed to sign in, and what an AI did to a
 * page. They read differently because they answer different questions, but all
 * three are "something happened while I was not looking", and the moment there is
 * no list the only way back is to provoke the event again — sign out and in for a
 * capture, launch again to see a failure, reopen the audit log for AI activity.
 *
 * Rows keep their action as data, so history from a previous run still shows what
 * happened and simply stops offering what it can no longer do.
 */
const store = useWorkspaceStore();
const embedded = useEmbeddedStore();
const confirm = useConfirmStore();
const { t, te } = useI18n();

/**
 * Saving a captured login is the shell's job: it owns the account dialog and the
 * site auto-creation. This page only knows which capture the row points at.
 */
const emit = defineEmits<{ saveCapture: [notice: LoginCaptureNotice] }>();

/** null = every kind. */
const filter = ref<MessageKind | null>(null);

const KINDS: MessageKind[] = ["login-capture", "account", "ai", "app"];

/**
 * Filter labels, named explicitly rather than built from the kind id.
 *
 * Deriving them from the string ("login-capture" → "logincapture") produced keys
 * that exist but read like a machine made them; naming the four is clearer than
 * a transform nobody can check at a glance.
 */
const KIND_LABELS: Record<MessageKind, string> = {
  "login-capture": "app.messageKindLoginCapture",
  account: "app.messageKindAccount",
  ai: "app.messageKindAi",
  app: "app.messageKindApp",
};

const rows = computed(() =>
  filter.value === null ? store.messages : store.messages.filter((item) => item.kind === filter.value),
);

function kindCount(kind: MessageKind | null): number {
  if (kind === null) return store.messages.length;
  return store.messages.filter((item) => item.kind === kind).length;
}

/** The headline, translated. A key that no longer exists shows its detail
 * instead of a raw `messages.x` — history survives releases that rename copy. */
function titleOf(message: AppMessageView): string {
  if (!te(message.titleKey)) return message.detail ?? message.titleKey;
  return t(message.titleKey, message.titleParams ?? {});
}

const ICONS = {
  "login-capture": KeyRound,
  account: Globe,
  ai: Bot,
  app: Info,
} as const;

function toneIcon(tone: AppMessageView["tone"]) {
  if (tone === "error") return CircleAlert;
  if (tone === "warning") return TriangleAlert;
  if (tone === "success") return CircleCheck;
  return ICONS.app;
}

/**
 * Why a row can no longer act.
 *
 * The two cases differ and the difference matters: a capture's secret is only
 * ever held in memory, so a row from a previous run is unrecoverable by design
 * (nothing was written to disk); a tab or an identity simply is not there any
 * more. Saying "expired" for both would suggest the password might still be
 * somewhere.
 */
function staleReason(message: AppMessageView): string {
  if (message.action?.type === "login-capture") return t("app.messageStaleCapture");
  return t("app.messageStaleTarget");
}

function whenOf(message: AppMessageView): string {
  const at = new Date(message.at);
  if (Number.isNaN(at.getTime())) return "";
  const sameDay = new Date().toDateString() === at.toDateString();
  return sameDay
    ? at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : at.toLocaleString(undefined, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}

/**
 * Runs a row's action.
 *
 * Each kind means a different "show me": a capture opens the account form, an
 * account reopens its login page, an AI row switches to the page it touched. The
 * row is marked read on the way, because using it is the strongest possible
 * statement that it was seen.
 */
/** Clearing also drops every capture the history pointed at, so it asks first. */
async function clearAll(): Promise<void> {
  const ok = await confirm.ask({
    title: t("app.messagesClear"),
    body: t("app.messagesClearBody"),
  });
  if (ok) await store.clearMessages();
}

async function act(message: AppMessageView): Promise<void> {
  if (message.stale || !message.action) return;
  void store.markMessageRead(message.id);
  if (message.action.type === "login-capture") {
    const notice = store.pendingLogins.find((item) => item.token === (message.action as { token: string }).token);
    if (notice) emit("saveCapture", notice);
    return;
  }
  if (message.action.type === "identity") {
    const { identityId } = message.action;
    const identity = store.identities.find((item) => item.id === identityId);
    if (!identity) return;
    // Opening the account is the fix for every reason a login failed: it puts
    // the login page on screen with the saved password already typed.
    await embedded.openIdentity(identityId);
    return;
  }
  await embedded.activate(message.action.tabId);
}
</script>

<template>
  <section class="page">
    <PageHeader :title="$t('app.messages')">
      <template #actions>
        <button
          type="button"
          class="ghost"
          :disabled="store.unreadMessages === 0"
          data-messages-read-all
          @click="store.markAllMessagesRead()"
        >
          {{ $t("app.messagesReadAll") }}
        </button>
        <button
          type="button"
          class="ghost"
          :disabled="store.messages.length === 0"
          data-messages-clear
          @click="clearAll"
        >
          {{ $t("app.messagesClear") }}
        </button>
      </template>
    </PageHeader>

    <div class="filters" role="tablist">
      <button
        type="button"
        class="chip"
        :class="{ on: filter === null }"
        :aria-selected="filter === null"
        role="tab"
        data-message-filter="all"
        @click="filter = null"
      >
        {{ $t("app.messagesAll") }}
        <span class="count mono">{{ kindCount(null) }}</span>
      </button>
      <button
        v-for="kind in KINDS"
        :key="kind"
        type="button"
        class="chip"
        :class="{ on: filter === kind }"
        :aria-selected="filter === kind"
        role="tab"
        :data-message-filter="kind"
        @click="filter = kind"
      >
        {{ $t(KIND_LABELS[kind]) }}
        <span class="count mono">{{ kindCount(kind) }}</span>
      </button>
    </div>

    <p v-if="rows.length === 0" class="empty">{{ $t("app.messagesEmpty") }}</p>

    <ul v-else class="rows">
      <li
        v-for="message in rows"
        :key="message.id"
        class="row"
        :class="[message.tone, { unread: !message.read, stale: message.stale }]"
        :data-message-kind="message.kind"
      >
        <span class="dot" aria-hidden="true"></span>
        <component
          :is="message.kind === 'app' ? toneIcon(message.tone) : ICONS[message.kind]"
          :size="14"
          class="kind-icon"
        />
        <div class="copy">
          <p class="title">{{ titleOf(message) }}</p>
          <p v-if="message.detail" class="detail mono">{{ message.detail }}</p>
        </div>
        <span class="when mono">{{ whenOf(message) }}</span>
        <button
          v-if="message.action && !message.stale"
          type="button"
          class="act"
          data-message-action
          @click="act(message)"
        >
          {{
            message.kind === "login-capture"
              ? $t("app.loginCaptureSave")
              : message.kind === "ai"
                ? $t("app.messageGotoTab")
                : $t("app.messageRelogin")
          }}
        </button>
        <span v-else-if="message.stale" class="stale-note" :title="staleReason(message)">{{
          $t("app.messageStale")
        }}</span>
        <button
          type="button"
          class="drop"
          :aria-label="$t('app.messageRemove')"
          :title="$t('app.messageRemove')"
          data-message-remove
          @click="store.removeMessage(message.id)"
        >
          <X :size="11" />
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  padding: 0 20px 20px;
}

.filters {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin: 2px 0 10px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 13px;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--fs-xs);
}

.chip:hover {
  background: var(--surface-2);
  color: var(--text);
}

.chip.on {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--line));
  background: var(--accent-soft);
  color: var(--text);
}

.count {
  font-size: var(--fs-2xs);
  color: var(--faint);
}

.chip.on .count {
  color: var(--text-secondary);
}

.empty {
  margin: 40px 0 0;
  text-align: center;
  font-size: var(--fs-sm);
  color: var(--faint);
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  min-height: 0;
}

.row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 4px;
  border-top: 1px solid var(--line-soft);
  min-width: 0;
}

.row:first-child {
  border-top: 0;
}

.row.unread .title {
  color: var(--text);
  font-weight: 500;
}

.row.stale {
  opacity: 0.55;
}

/* The unread marker is a dot, not a background: a whole tinted row reads as
   selected, and rows are not selectable. */
.dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  flex: 0 0 5px;
  background: transparent;
}

.row.unread .dot {
  background: var(--accent);
}

.kind-icon {
  flex: 0 0 auto;
  color: var(--muted);
}

.row.error .kind-icon {
  color: var(--red);
}

.row.warning .kind-icon {
  color: var(--amber);
}

.row.success .kind-icon {
  color: var(--green);
}

.copy {
  flex: 1 1 auto;
  min-width: 0;
}

.title {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail {
  margin: 2px 0 0;
  font-size: var(--fs-2xs);
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.when {
  flex: 0 0 auto;
  font-size: var(--fs-2xs);
  color: var(--faint);
}

.act {
  flex: 0 0 auto;
  font-size: var(--fs-xs);
  color: var(--accent-text);
  padding: 3px 8px;
  border-radius: 4px;
}

.act:hover {
  background: color-mix(in srgb, var(--text) 6%, transparent);
}

.stale-note {
  flex: 0 0 auto;
  font-size: var(--fs-2xs);
  color: var(--faint);
}

.drop {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  color: var(--faint);
  padding: 3px;
  border-radius: 4px;
}

.drop:hover {
  background: color-mix(in srgb, var(--text) 6%, transparent);
  color: var(--text-secondary);
}

.ghost {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  padding: 4px 9px;
  border-radius: var(--radius-sm);
}

.ghost:hover:not(:disabled) {
  background: var(--surface-2);
  color: var(--text);
}

.ghost:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
