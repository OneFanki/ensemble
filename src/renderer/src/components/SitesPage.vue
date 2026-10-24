<script setup lang="ts">
import type { Site, Tag as WorkspaceTag } from "@shared/types";
import { Globe, Pencil, Plus, Trash2, Waypoints } from "lucide-vue-next";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useConfirmStore } from "../stores/confirm";
import { useWorkspaceStore } from "../stores/workspace";

const emit = defineEmits<{
  newSite: [];
  editSite: [id: string];
  openSite: [id: string];
}>();

const store = useWorkspaceStore();
const confirm = useConfirmStore();
const { t } = useI18n();

const sites = computed(() => store.sites);
const tags = computed(() => store.snapshot?.tags ?? []);

/**
 * Sites grouped by tag. A site with several tags appears in each group — the
 * list is a view, not a partition, so nothing is hidden. Untagged sites go to a
 * trailing "no tag" group.
 */
const groups = computed(() => {
  const result: Array<{ key: string; tag?: WorkspaceTag; sites: Site[] }> = [];
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

function passwordSet(site: Site): boolean {
  return Boolean(store.credentials?.site[site.id]);
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


import AppButton from "./ui/AppButton.vue";
import IconButton from "./ui/IconButton.vue";
</script>

<template>
  <section class="sites">
    <header class="head">
      <div class="head-copy">
        <h1>{{ $t("app.sites") }}</h1>
        <p class="head-note">{{ $t("app.sitesSubtitle") }}</p>
      </div>
      <div class="head-actions">
        <AppButton variant="primary" data-tour="new-site" @click="emit('newSite')">
          <Plus :size="13" />
          {{ $t("app.newSite") }}
        </AppButton>
      </div>
    </header>

    <div v-if="!sites.length" class="empty">
      <Waypoints :size="22" />
      <p>{{ $t("app.emptySites") }}</p>
      <AppButton variant="primary" @click="emit('newSite')">
        <Plus :size="13" />
        {{ $t("app.newSite") }}
      </AppButton>
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
          >
            <div class="card-head">
              <span class="env-dot"></span>
              <h2 class="env-name">{{ site.name }}</h2>
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
            </dl>

            <div class="card-actions">
              <AppButton size="sm" :title="$t('app.openSiteHint')"
                @click="store.markSiteUsed(site.id); emit('openSite', site.id)">
                <Globe :size="12" />
                {{ $t("app.openSite") }}
              </AppButton>
              <IconButton :ariaLabel="$t('app.edit')" @click="emit('editSite', site.id)">
                <Pencil :size="12" />
              </IconButton>
              <IconButton variant="danger" :ariaLabel="$t('app.delete')"
                @click="remove(site)">
                <Trash2 :size="12" />
              </IconButton>
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
  /* Rows size to their card, never to leftover container height: the cards clip
     their own overflow, so a compressed row silently eats their footer. */
  grid-auto-rows: min-content;
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

.icon-btn + .icon-btn {
  margin-left: 0;
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

.btn.small {
  padding: 5px 10px;
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
