<script setup lang="ts">
import type { RoleColor, Site, SiteTag } from "@shared/types";
import { Check, Globe, Pencil, Plus, Tag, Trash2, Waypoints } from "lucide-vue-next";
import { computed, nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useConfirmStore } from "../stores/confirm";
import { useWorkspaceStore } from "../stores/workspace";

const emit = defineEmits<{
  newSite: [];
  editSite: [id: string];
}>();

const store = useWorkspaceStore();
const confirm = useConfirmStore();
const { t } = useI18n();

const sites = computed(() => store.sites);
const tags = computed(() => store.snapshot?.siteTags ?? []);

const tagsOpen = ref(false);
const newTagName = ref("");
const newTagColor = ref<RoleColor>("slate");
const tagError = ref("");
/** Tag being renamed inline; `null` means no chip is in edit mode. */
const renamingTagId = ref<string | null>(null);
const renameTagName = ref("");
const renameInput = ref<HTMLInputElement[] | null>(null);

const TAG_COLORS: RoleColor[] = ["amber", "teal", "violet", "rose", "blue", "slate"];

/**
 * Sites grouped by tag. A site with several tags appears in each group — the
 * list is a view, not a partition, so nothing is hidden. Untagged sites go to a
 * trailing "no tag" group.
 */
const groups = computed(() => {
  const result: Array<{ key: string; tag?: SiteTag; sites: Site[] }> = [];
  for (const tag of tags.value) {
    const members = sites.value.filter((site) => site.tagIds?.includes(tag.id));
    if (members.length > 0) result.push({ key: tag.id, tag, sites: members });
  }
  const untagged = sites.value.filter((site) => !site.tagIds || site.tagIds.length === 0);
  if (untagged.length > 0) result.push({ key: "__untagged__", sites: untagged });
  return result;
});

function identityCount(site: Site): number {
  return store.identities.filter((identity) => identity.siteId === site.id).length;
}

function viewCount(site: Site): number {
  return store.views.filter((view) => view.siteId === site.id).length;
}

function engineLabel(site: Site): string {
  const engine =
    store.engines.find((item) => item.id === site.defaultEngineId) ?? store.defaultEngine;
  if (!engine) return t("app.noBrowserFound");
  return `${engine.brand} ${engine.version ?? ""}`.trim();
}

function passwordSet(site: Site): boolean {
  return Boolean(store.credentials?.site[site.id]);
}

function isActive(site: Site): boolean {
  return store.activeSite?.id === site.id;
}

async function remove(site: Site) {
  const accepted = await confirm.ask({
    title: t("app.delete"),
    body: t("app.deleteSiteConfirm", { name: site.name }),
    confirmLabel: t("app.delete"),
    tone: "danger",
  });
  if (!accepted) return;
  await store.deleteSite(site.id);
}

async function createTag() {
  tagError.value = "";
  const name = newTagName.value.trim();
  if (!name) {
    tagError.value = t("app.errTagName");
    return;
  }
  // `run` in the store turns a rejection into a toast; a failed save comes back
  // as `undefined`, so the draft is only cleared on success.
  const saved = await store.saveSiteTag({ name, color: newTagColor.value });
  if (saved !== undefined) newTagName.value = "";
}

/**
 * Renaming happens in place on the chip: a native prompt for one short string
 * was both out of place visually and impossible to style.
 */
function startRenameTag(tag: SiteTag): void {
  renamingTagId.value = tag.id;
  renameTagName.value = tag.name;
  void nextTick(() => renameInput.value?.[0]?.select());
}

async function commitRenameTag(tag: SiteTag): Promise<void> {
  // Enter commits and unmounts the input, which also fires `blur`; the guard
  // makes the second call a no-op instead of a duplicate save.
  if (renamingTagId.value !== tag.id) return;
  const name = renameTagName.value.trim();
  renamingTagId.value = null;
  if (!name || name === tag.name) return;
  // `run` in the store reports failures as a toast; the chip keeps the old name.
  await store.saveSiteTag({ id: tag.id, name, color: tag.color });
}

async function removeTag(tag: SiteTag) {
  const accepted = await confirm.ask({
    title: t("app.delete"),
    body: t("app.deleteTagConfirm", { name: tag.name }),
    confirmLabel: t("app.delete"),
    tone: "danger",
  });
  if (!accepted) return;
  await store.deleteSiteTag(tag.id);
}
</script>

<template>
  <section class="sites">
    <header class="head">
      <div class="head-copy">
        <h1>{{ $t("app.sites") }}</h1>
        <p class="head-note">{{ $t("app.sitesSubtitle") }}</p>
      </div>
      <div class="head-actions">
        <button class="btn" type="button" @click="tagsOpen = !tagsOpen">
          <Tag :size="13" />
          {{ $t("app.siteTags") }}
          <span v-if="tags.length" class="tag-count mono">{{ tags.length }}</span>
        </button>
        <button class="btn" type="button" @click="store.launchCleanSession()">
          <Globe :size="13" />
          {{ $t("app.cleanSessionNoEnv") }}
        </button>
        <button class="btn primary" type="button" data-tour="new-site" @click="emit('newSite')">
          <Plus :size="13" />
          {{ $t("app.newSite") }}
        </button>
      </div>
    </header>

    <!-- Tag management: create, rename, delete. Tags never affect sites' data. -->
    <div v-if="tagsOpen" class="tag-panel">
      <div class="tag-create">
        <input
          v-model="newTagName"
          type="text"
          :placeholder="$t('app.tagNamePlaceholder')"
          @keydown.enter.prevent="createTag"
        />
        <span class="color-row">
          <button
            v-for="color in TAG_COLORS"
            :key="color"
            type="button"
            class="color-dot"
            :class="{ picked: newTagColor === color }"
            :style="{ background: `var(--role-${color})` }"
            :aria-label="color"
            @click="newTagColor = color"
          ></button>
        </span>
        <button class="btn" type="button" @click="createTag">{{ $t("app.tagCreate") }}</button>
      </div>
      <p v-if="tagError" class="tag-error">{{ tagError }}</p>

      <div v-if="tags.length" class="tag-list">
        <span v-for="tag in tags" :key="tag.id" class="tag-pill" :style="{ '--tag': `var(--role-${tag.color})` }">
          <span class="tag-dot"></span>
          <input
            v-if="renamingTagId === tag.id"
            ref="renameInput"
            v-model="renameTagName"
            class="tag-rename"
            @keydown.enter.prevent="commitRenameTag(tag)"
            @keydown.esc.prevent="renamingTagId = null"
            @blur="commitRenameTag(tag)"
          />
          <button v-else type="button" class="tag-name" @click="startRenameTag(tag)">
            {{ tag.name }}
          </button>
          <button type="button" class="tag-remove" :aria-label="$t('app.delete')" @click="removeTag(tag)">
            ×
          </button>
        </span>
      </div>
      <p v-else class="tag-empty">{{ $t("app.noSiteTags") }}</p>
    </div>

    <div v-if="!sites.length" class="empty">
      <Waypoints :size="22" />
      <p>{{ $t("app.emptySites") }}</p>
      <button class="btn primary" type="button" @click="emit('newSite')">
        <Plus :size="13" />
        {{ $t("app.newSite") }}
      </button>
    </div>

    <div v-else class="group-list">
      <section v-for="group in groups" :key="group.key" class="group">
        <header class="group-head">
          <span
            v-if="group.tag"
            class="group-dot"
            :style="{ background: `var(--role-${group.tag.color})` }"
          ></span>
          <span class="group-name">
            {{ group.tag?.name ?? $t("app.untaggedSites") }}
          </span>
          <span class="group-count mono">{{ group.sites.length }}</span>
        </header>

        <div class="env-grid">
          <article
            v-for="site in group.sites"
            :key="site.id"
            class="env-card"
            :class="{ active: isActive(site) }"
          >
            <div class="card-head">
              <span class="env-dot"></span>
              <h2 class="env-name">{{ site.name }}</h2>
              <span v-if="isActive(site)" class="active-chip">
                <Check :size="10" />
                {{ $t("app.currentSiteBadge") }}
              </span>
            </div>

            <p class="env-url mono" :title="site.baseUrl">
              <Globe :size="11" />
              <span>{{ site.baseUrl }}</span>
            </p>

            <dl class="env-meta">
              <div>
                <dt>{{ $t("app.identities") }}</dt>
                <dd class="mono">{{ identityCount(site) }}</dd>
              </div>
              <div>
                <dt>{{ $t("app.views") }}</dt>
                <dd class="mono">{{ viewCount(site) }}</dd>
              </div>
              <div>
                <dt>{{ $t("app.defaultPassword") }}</dt>
                <dd>{{ passwordSet(site) ? $t("app.passwordSet") : $t("app.passwordNotSet") }}</dd>
              </div>
              <div class="wide">
                <dt>{{ $t("app.defaultEngine") }}</dt>
                <dd>{{ engineLabel(site) }}</dd>
              </div>
            </dl>

            <div class="card-actions">
              <button
                v-if="!isActive(site)"
                class="btn small"
                type="button"
                @click="store.setActiveSite(site.id)"
              >
                {{ $t("app.switchHere") }}
              </button>
              <span v-else class="active-note">{{ $t("app.alreadyActive") }}</span>
              <button class="icon-btn" type="button" :aria-label="$t('app.edit')" @click="emit('editSite', site.id)">
                <Pencil :size="12" />
              </button>
              <button
                class="icon-btn danger"
                type="button"
                :aria-label="$t('app.delete')"
                @click="remove(site)"
              >
                <Trash2 :size="12" />
              </button>
            </div>
          </article>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.sites {
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
  margin-top: 10px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
  align-content: start;
}

.group-list {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.group-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--line-soft);
}

.group-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 7px;
}

.group-name {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text-secondary);
}

.group-count {
  font-size: 10px;
  color: var(--faint);
}

.tag-panel {
  margin-top: 14px;
  padding: 12px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
  background: var(--surface);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.tag-create {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.tag-create input {
  flex: 1 1 180px;
  min-width: 140px;
  padding: 5px 9px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
}

.color-row {
  display: flex;
  gap: 4px;
}

.color-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  padding: 0;
}

.color-dot.picked {
  border-color: var(--text);
}

.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tag-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 4px 2px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--tag) 14%, var(--surface-2));
  border: 1px solid color-mix(in srgb, var(--tag) 35%, transparent);
}

.tag-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--tag);
  flex: 0 0 6px;
}

.tag-name {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  padding: 0;
}

.tag-name:hover {
  color: var(--text);
}

.tag-rename {
  width: 96px;
  border: none;
  border-bottom: 1px solid var(--tag);
  background: transparent;
  color: var(--text);
  font-size: 11px;
  padding: 0 0 1px;
  outline: none;
}

.tag-remove {
  border: none;
  background: transparent;
  color: var(--faint);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 0 3px;
}

.tag-remove:hover {
  color: var(--red);
}

.tag-count {
  font-size: 10px;
  color: var(--faint);
}

.tag-error {
  font-size: 11px;
  color: var(--red);
}

.tag-empty {
  font-size: 11px;
  color: var(--faint);
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
