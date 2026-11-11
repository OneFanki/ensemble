<script setup lang="ts">
import type { AppMessageView, LoginCaptureNotice, MessageKind } from "@shared/types";
import { ChevronRight } from "lucide-vue-next";
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  MESSAGE_KINDS,
  MESSAGE_KIND_LABELS,
  useMessageRows,
} from "../composables/messageRows";
import { useConfirmStore } from "../stores/confirm";
import { useWorkspaceStore } from "../stores/workspace";
import MessageDetailLayer from "./MessageDetailLayer.vue";
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
 *
 * This page and the toolbar bell's popover show the same rows; everything about
 * a row that is not layout comes from `useMessageRows`, so the two cannot drift.
 */
const store = useWorkspaceStore();
const confirm = useConfirmStore();
const { t } = useI18n();

/**
 * Saving a captured login is the shell's job: it owns the account dialog and the
 * site auto-creation. This page only knows which capture the row points at.
 */
const emit = defineEmits<{ saveCapture: [notice: LoginCaptureNotice] }>();

const { titleOf, iconOf, whenOf, staleReason, actionLabelOf, act } = useMessageRows(
  (notice) => emit("saveCapture", notice),
);

/** The open row, and the row element the detail hangs off. */
const openedId = ref<string | null>(null);
const openedAnchor = ref<HTMLElement | null>(null);
const opened = computed(() => rows.value.find((item) => item.id === openedId.value) ?? null);

/**
 * Clicking a row opens its detail as a layer.
 *
 * The row carries two buttons of its own (act, remove) and used to have them
 * inline; the click on the row itself had nothing to open. Expanding in place
 * moves every row below it, which is the one thing a list must not do while you
 * are reading it — so the detail floats, anchored to its row, and the list stays
 * put.
 */
function openDetail(message: AppMessageView, event: MouseEvent | KeyboardEvent): void {
  if (!message.action && !message.stale) return;
  openedAnchor.value = (event.currentTarget as HTMLElement | null) ?? null;
  openedId.value = message.id;
  if (!message.read) void store.markMessageRead(message.id);
}

function closeDetail(): void {
  openedId.value = null;
  openedAnchor.value = null;
}

async function actFromDetail(message: AppMessageView): Promise<void> {
  closeDetail();
  await act(message);
}

function removeFromDetail(message: AppMessageView): void {
  closeDetail();
  void store.removeMessage(message.id);
}

/** null = every kind. */
const filter = ref<MessageKind | null>(null);

const KINDS = MESSAGE_KINDS;
const KIND_LABELS = MESSAGE_KIND_LABELS;

const rows = computed(() =>
  filter.value === null ? store.messages : store.messages.filter((item) => item.kind === filter.value),
);

// The open row can vanish under the layer (cleared, removed, filtered out).
watch(rows, () => {
  if (openedId.value && !rows.value.some((item) => item.id === openedId.value)) closeDetail();
});

/*
 * Re-read the history on every visit.
 *
 * `stale` is decided by the main process when the list is fetched — a capture's
 * token dies with the process, a tab closes — so a page that keeps the copy it
 * loaded at startup shows actions that no longer work, and misses messages
 * recorded while another page was on screen. This page is a destination you
 * come back to; coming back is the moment to ask again.
 */
onMounted(() => void store.refreshMessages());

function kindCount(kind: MessageKind | null): number {
  if (kind === null) return store.messages.length;
  return store.messages.filter((item) => item.kind === kind).length;
}

/** Clearing also drops every capture the history pointed at, so it asks first. */
async function clearAll(): Promise<void> {
  const ok = await confirm.ask({
    title: t("app.messagesClear"),
    body: t("app.messagesClearBody"),
  });
  if (ok) await store.clearMessages();
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
        :class="[
          message.tone,
          {
            unread: !message.read,
            stale: message.stale,
            open: openedId === message.id,
            static: !message.action && !message.stale,
          },
        ]"
        :data-message-kind="message.kind"
        :data-message-id="message.id"
        :aria-expanded="message.action || message.stale ? openedId === message.id : undefined"
        :tabindex="message.action || message.stale ? 0 : undefined"
        role="button"
        @click="openDetail(message, $event)"
        @keydown.enter.prevent="openDetail(message, $event)"
        @keydown.space.prevent="openDetail(message, $event)"
      >
        <span class="dot" aria-hidden="true"></span>
        <component :is="iconOf(message)" :size="14" class="kind-icon" />
        <div class="copy">
          <p class="title">{{ titleOf(message) }}</p>
          <p v-if="message.detail" class="detail mono">{{ message.detail }}</p>
        </div>
        <span class="when mono">{{ whenOf(message) }}</span>
        <!--
          The row's state, not its actions: the action and the delete live in the
          detail layer, so the row stays one target instead of three. "Stale" is
          the exception — it is why the row has no action, so it belongs here.
        -->
        <span v-if="message.stale" class="stale-note" :title="staleReason(message)">{{
          $t("app.messageStale")
        }}</span>
        <ChevronRight :size="12" class="chevron" aria-hidden="true" />
      </li>
    </ul>

    <!-- The row's detail, anchored to it. `below` here: this page has the room,
         and the list is not what the user is picking between at that moment. -->
    <MessageDetailLayer
      :message="opened"
      :anchor="openedAnchor"
      @close="closeDetail"
      @act="actFromDetail"
      @remove="removeFromDetail"
    />
  </section>
</template>

<style scoped>
/*
 * The shared page frame's padding, not this page's own.
 *
 * It was inset by 20px with no top padding, which put the title 24px higher than
 * the same title on every other management page and 8px further left — so
 * switching to messages read as the whole layout shifting. The shell's band
 * above the page is what reserves the caption area; the page's own 24/28 inset
 * sits on top of it like everywhere else.
 */
.page {
  padding: 24px 28px;
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

/* The shared `.empty` frame owns the margin and the centring. This page used to
   override the margin to `40px 0 0`, which cancelled the horizontal auto margin:
   the sentence stayed 560px wide in the top-left corner with its own
   `text-align: center` only centring it inside that box. */

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
  cursor: pointer;
}

.row:first-child {
  border-top: 0;
}

.row:hover:not(.static) {
  background: color-mix(in srgb, var(--text) 3%, transparent);
}

/* The row whose detail is open. It is the only thing on screen saying which
   message the layer belongs to, since the layer floats free of the list. */
.row.open {
  background: var(--selected);
}

/* A row with nothing to open: no pointer, no hover, no chevron. */
.row.static {
  cursor: default;
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

.stale-note {
  flex: 0 0 auto;
  font-size: var(--fs-2xs);
  color: var(--faint);
}

.chevron {
  flex: 0 0 auto;
  color: var(--faint);
  transition: transform var(--motion-fast) var(--ease-out);
}

.row.open .chevron {
  transform: rotate(90deg);
}

/* A row with nothing to open has no chevron to offer. */
.row.static .chevron {
  visibility: hidden;
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
