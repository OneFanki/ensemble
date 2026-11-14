<script setup lang="ts">
/**
 * The AI access policy for profile pages.
 *
 * This is the settings page's full editor: every mode with the sentence that
 * explains it, and the whole address list with per-entry removal and a bulk add
 * from bookmarks. The toolbar's AI panel carries only the decision about the page
 * in front of the user, because that is the question they have there — mixing
 * the four modes into a toolbar popover made the panel a settings page in a
 * 380px box.
 *
 * The mode and the list are edited separately on purpose. Switching to "allow
 * all" and back must not lose the addresses someone typed — a policy switch is a
 * decision about how to read the list, not a decision to delete it.
 */
import { normalizeAiOrigin } from "@shared/ai-policy";
import type { McpPatch, McpStatus } from "@shared/types";
import { Bookmark, Plus, ShieldCheck, X } from "lucide-vue-next";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useWorkspaceStore } from "../stores/workspace";
import AppButton from "./ui/AppButton.vue";

const props = defineProps<{
  /** Live endpoint status; absent while the server has not answered yet. */
  status?: McpStatus;
}>();

const store = useWorkspaceStore();
const { t } = useI18n();

const mode = computed(() => props.status?.aiMode ?? "allowlist");
const origins = computed(() => props.status?.aiOrigins ?? []);

/**
 * The four answers, in the order they widen.
 *
 * Two list modes then the two absolute ones, which is how a person moves: "only
 * these", "everything but these", "everything", "nothing". A segmented control
 * is wrong here — the four are not one dial, they are two families — so each row
 * is its own choice with its own sentence.
 */
const modes = computed(() => [
  { id: "allowlist" as const, label: t("app.aiModeAllowlist"), note: t("app.aiModeAllowlistNote") },
  { id: "denylist" as const, label: t("app.aiModeDenylist"), note: t("app.aiModeDenylistNote") },
  { id: "allow-all" as const, label: t("app.aiModeAllowAll"), note: t("app.aiModeAllowAllNote") },
  { id: "deny-all" as const, label: t("app.aiModeDenyAll"), note: t("app.aiModeDenyAllNote") },
]);

/** The two modes that read the list; the others keep it but ignore it. */
const listMode = computed(() => mode.value === "allowlist" || mode.value === "denylist");

const draft = ref("");
const error = ref("");

function patch(input: McpPatch): void {
  void store.updateMcp(input);
}

async function addOrigin(): Promise<void> {
  error.value = "";
  const origin = normalizeAiOrigin(draft.value);
  if (!origin) {
    error.value = t("app.aiOriginInvalid");
    return;
  }
  if (origins.value.includes(origin)) {
    error.value = t("app.aiOriginDuplicate");
    return;
  }
  draft.value = "";
  await store.updateMcp({ aiOrigin: { origin, allowed: true } });
}

/** One address from the bookmark tree, reduced to its origin. */
function bookmarkOrigins(): string[] {
  const seen = new Set<string>(origins.value);
  const found: string[] = [];
  for (const bookmark of store.bookmarks) {
    const origin = normalizeAiOrigin(bookmark.url);
    if (!origin || seen.has(origin)) continue;
    seen.add(origin);
    found.push(origin);
  }
  return found;
}

/**
 * Adds every bookmark origin the list does not have yet.
 *
 * "从书签选择" adds the whole set rather than opening a picker: the bookmarks are
 * the user's own addresses, the list is an address list, and a second chooser
 * inside a popover would be a dialog inside a menu. Anything already listed is
 * skipped, so pressing it twice is harmless.
 */
async function addFromBookmarks(): Promise<void> {
  const missing = bookmarkOrigins();
  if (!missing.length) return;
  // One write, not one per address: each `updateMcp` rewrites the settings file,
  // and a user with forty bookmarks would otherwise watch the list fill in one
  // round-trip at a time.
  await store.updateMcp({ aiOriginsAdd: missing });
}

const bookmarkCount = computed(() => bookmarkOrigins().length);
</script>

<template>
  <div class="ai-policy">
    <!--
      The mode picker, above the list.

      It used to be one implicit policy — an allowlist — with no way to see or
      change it. The four rows say what each answer means, because "黑名单" alone
      does not tell you whether an address in the list is allowed or blocked.
    -->
    <div class="modes" role="radiogroup" :aria-label="t('app.aiPolicyMode')">
      <button
        v-for="item in modes"
        :key="item.id"
        type="button"
        class="mode"
        :class="{ on: mode === item.id }"
        role="radio"
        :aria-checked="mode === item.id"
        :data-ai-mode="item.id"
        @click="patch({ aiMode: item.id })"
      >
        <span class="radio" aria-hidden="true"></span>
        <span class="mode-copy">
          <span class="mode-name">{{ item.label }}</span>
          <span class="mode-note">{{ item.note }}</span>
        </span>
      </button>
    </div>

    <!--
      The address list stays visible in every mode, including the two that ignore
      it. Hiding it under "允许全部" would make it look deleted; keeping it greyed
      says "still here, not being read right now".
    -->
    <div class="list-block" :class="{ muted: !listMode }">
      <div class="list-head">
        <span class="list-title">{{ mode === "denylist" ? t("app.aiOriginBlocked") : t("app.aiOriginAllowed") }}</span>
        <span class="list-count mono">{{ origins.length }}</span>
      </div>

      <div class="list">
        <p v-if="!origins.length" class="list-empty">
          {{ listMode ? t("app.aiOriginsEmpty") : t("app.aiOriginsKept") }}
        </p>
        <div v-for="origin in origins" :key="origin" class="origin-row">
          <ShieldCheck :size="11" class="origin-icon" />
          <span class="origin-name mono">{{ origin }}</span>
          <button
            type="button"
            class="origin-remove"
            :aria-label="t('app.aiOriginRemove')"
            :data-ai-origin-remove="origin"
            @click="patch({ aiOrigin: { origin, allowed: false } })"
          >
            <X :size="11" />
          </button>
        </div>
      </div>

      <!--
        Adding is at the top of the list, above the rows: with twenty addresses
        the entry field at the bottom would be off the panel, which is the one
        place the user needs when the list is long.
      -->
      <form class="add" @submit.prevent="addOrigin">
        <input
          v-model="draft"
          class="add-input"
          type="text"
          :placeholder="t('app.aiOriginPlaceholder')"
          data-ai-origin-input
        />
        <AppButton type="submit" data-ai-origin-add>
          <Plus :size="12" />
          {{ t("app.aiOriginAdd") }}
        </AppButton>
        <AppButton
          v-if="bookmarkCount > 0"
          type="button"
          :data-ai-origin-from-bookmarks="bookmarkCount"
          @click="addFromBookmarks"
        >
          <Bookmark :size="12" />
          {{ t("app.aiOriginFromBookmarks", { count: bookmarkCount }) }}
        </AppButton>
      </form>
      <p v-if="error" class="add-error">{{ error }}</p>
    </div>
  </div>
</template>

<style scoped>
.ai-policy {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}

.modes {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.mode {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 7px 8px;
  border-radius: var(--radius-sm);
  text-align: left;
  color: var(--text-secondary);
}

.mode:hover {
  background: color-mix(in srgb, var(--text) 5%, transparent);
}

/* The selected row is a filled chip, not a tinted one: four rows of gold tints
   would make every row look half-selected. */
.mode.on {
  background: var(--selected);
  color: var(--text);
}

.radio {
  flex: 0 0 auto;
  width: 12px;
  height: 12px;
  margin-top: 2px;
  border-radius: 50%;
  border: 1px solid var(--line);
  background: var(--bg-elevated);
}

.mode.on .radio {
  border-color: var(--text);
  /* The inner dot is drawn with an inset ring rather than a pseudo-element: one
     property, and it keeps the 12px box from needing a second positioning box. */
  box-shadow: inset 0 0 0 3px var(--bg-elevated), inset 0 0 0 6px var(--text);
}

.mode-copy {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.mode-name {
  font-size: 12px;
}

.mode-note {
  font-size: var(--fs-2xs);
  color: var(--faint);
  line-height: 1.45;
}

/* Out of the reading path but still editable: the two absolute modes keep the
   addresses, they just do not consult them. */
.list-block.muted .list {
  opacity: 0.62;
}

.list-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 3px;
}

.list-title {
  font-size: var(--fs-2xs);
  letter-spacing: 0.04em;
  color: var(--faint);
}

.list-count {
  margin-left: auto;
  font-size: var(--fs-2xs);
  color: var(--faint);
}

.list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.list-empty {
  margin: 0;
  padding: 9px 8px;
  font-size: var(--fs-2xs);
  color: var(--faint);
}

.origin-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 6px;
  background: var(--surface);
}

.origin-row + .origin-row {
  border-top: 1px solid var(--line-soft);
}

.origin-icon {
  flex: 0 0 auto;
  color: var(--faint);
}

.origin-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.origin-remove {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: var(--radius-sm);
  color: var(--dim);
}

.origin-remove:hover {
  background: color-mix(in srgb, var(--red) 14%, transparent);
  color: var(--red);
}

.add {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.add-input {
  flex: 1 1 140px;
  min-width: 0;
  height: var(--control-md);
  padding: 0 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--bg-elevated);
  color: var(--text);
  font-size: var(--fs-sm);
  outline: 0;
}

.add-input:focus {
  border-color: color-mix(in srgb, var(--line) 55%, var(--accent));
}

.add-error {
  margin: 4px 0 0;
  font-size: var(--fs-2xs);
  color: var(--red);
}
</style>
