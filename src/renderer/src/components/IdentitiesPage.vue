<script setup lang="ts">
import type { BrowserProfile, Identity, RoleColor, Site } from "@shared/types";
import {
  Check,
  CheckSquare,
  Download,
  Globe,
  HeartPulse,
  Layers,
  Link2,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Search,
  ShieldOff,
  Square,
  Star,
  Trash2,
  Users,
  X,
} from "lucide-vue-next";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { onClickOutside } from "@vueuse/core";
import { useAnchoredPanel } from "../composables/anchoredPanel";
import { useConfirmStore } from "../stores/confirm";
import { useEmbeddedStore } from "../stores/embedded";
import { useWorkspaceStore } from "../stores/workspace";
import Modal from "./Modal.vue";
import SelectField from "./SelectField.vue";
import AppButton from "./ui/AppButton.vue";
import EmptyState from "./ui/EmptyState.vue";
import FormField from "./ui/FormField.vue";
import IconButton from "./ui/IconButton.vue";
import LaunchSplitButton from "./ui/LaunchSplitButton.vue";
import TextField from "./ui/TextField.vue";

const emit = defineEmits<{
  newSite: [];
  editSite: [siteId: string];
  newIdentity: [siteId?: string];
  editIdentity: [id: string];
  sessionHealth: [];
  /** A page was opened: the pane's content is no longer what the user wants. */
  launched: [];
}>();

const store = useWorkspaceStore();
const embedded = useEmbeddedStore();
const confirm = useConfirmStore();
const { t } = useI18n();
const query = ref("");

/*
 * Sessions: the jars pages can be opened in, above the accounts.
 *
 * A named profile is not a setting about the app, it is one of the places
 * browsing happens — and this pane is where browsing starts. Managing them
 * (rename, delete, make default) is a settings job, but *launching* one belongs
 * here, next to the accounts, because "open the daily session" and "open this
 * account" are the same sentence with a different subject.
 *
 * The clean session is listed last and is not renamed here: it is the one fixed
 * throwaway, and a throwaway with a custom name invites people to keep it.
 */
const persistentProfiles = computed(() =>
  (store.settings.profiles ?? []).filter((profile) => profile.retention !== "ephemeral"),
);
const cleanProfile = computed(() =>
  (store.settings.profiles ?? []).find((profile) => profile.retention === "ephemeral"),
);
const defaultProfileId = computed(() => store.settings.defaultProfileId);

/**
 * A launch happened, so the pane has done its job.
 *
 * Opening the pane is a request for one of two things — pick an account, or pick
 * an identity — and both end with a page on screen. Leaving the pane on top of it
 * means every launch costs a second click to dismiss what the first click was
 * for; the browser underneath is the answer.
 */
async function launchSession(profileId: string): Promise<void> {
  await embedded.openProfileTab(profileId);
  emit("launched");
}

/**
 * Creating a global identity from the list it joins.
 *
 * A form, so it is a dialog: the name is the only field, and a dialog puts the
 * focus in it and the verdict one click away. Created from this list rather than
 * from a settings page, because "which jars do I have" and "one more" are the
 * same question asked in the same place.
 *
 * The row is created and listed; it is not launched. Unlike the account bar's own
 * "+" — where the chip only exists once a window is running, so creating one
 * means opening it — an identity is a list entry that stays until deleted, and a
 * stray blank page from a mis-click would be noise. The new row is right there to
 * click.
 */
const identityCreateOpen = ref(false);
const identityName = ref("");
const identityError = ref("");
/**
 * Set while the dialog is renaming an existing row; `null` means it is creating
 * one. Declared with the rest of the dialog state because `openCreateIdentity`
 * has to clear it — a create opened after a rename would otherwise carry the old
 * row along and overwrite it.
 */
const renameTarget = ref<BrowserProfile | null>(null);

function openCreateIdentity(): void {
  identityName.value = "";
  identityError.value = "";
  renameTarget.value = null;
  identityCreateOpen.value = true;
}

function closeIdentityDialog(): void {
  identityCreateOpen.value = false;
  renameTarget.value = null;
}

async function submitIdentity(): Promise<void> {
  const name = identityName.value.trim();
  if (!name) {
    identityError.value = t("app.sessionNeedsName");
    return;
  }
  const saved = await store.createProfile(name);
  // `run` in the store answers `undefined` after toasting the rejection, so the
  // dialog only closes on a write that landed.
  if (saved === undefined) return;
  identityCreateOpen.value = false;
  identityError.value = "";
}

/**
 * Renaming a global identity.
 *
 * Same dialog as creating one, with the row's current name filled in — an
 * identity has a name and nothing else, so the two are one form. Built-ins are
 * not offered it: their ids are what old partitions are looked up by, and a
 * renamed built-in would only make the label disagree with the data.
 */
function openRenameIdentity(profile: BrowserProfile): void {
  identityName.value = profile.name;
  identityError.value = "";
  renameTarget.value = profile;
  identityCreateOpen.value = true;
}

async function submitIdentityRename(): Promise<void> {
  const target = renameTarget.value;
  if (!target) return;
  const name = identityName.value.trim();
  if (!name) {
    identityError.value = t("app.sessionNeedsName");
    return;
  }
  const saved = await store.renameProfile(target.id, name);
  if (saved === undefined) return;
  identityCreateOpen.value = false;
  renameTarget.value = null;
  identityError.value = "";
}

/** Deleting one: the confirm names it, because the row is not in view any more. */
async function removeIdentity(profile: BrowserProfile): Promise<void> {
  const accepted = await confirm.ask({
    title: t("app.sessionDeleteTitle"),
    body: t("app.sessionDeleteBody", { name: profile.name }),
    confirmLabel: t("app.delete"),
    tone: "danger",
  });
  if (!accepted) return;
  await store.deleteProfile(profile.id);
}

/**
 * Which of the page's two faces is showing.
 *
 * `use` (the default) answers one question: "which account do I open now". It
 * shows tiles — avatar, name, one status dot — and a click launches. That is what
 * this page is for almost every time it is opened, and a row table was the wrong
 * shape for it: a table is for reading rows field by field, which is what
 * *changing* accounts needs.
 *
 * `edit` is the low-frequency face: rows with every field, per-row actions,
 * selection for bulk work, and the only place sites and groups are rearranged.
 * Everything that writes lives here, so the tile face stays clickable without
 * "was that the row I meant to edit?" mistakes.
 *
 * The state is remembered for the session only: opening the pane always starts on
 * `use`, because arriving at a management table when you meant to open an account
 * is the failure this split exists to prevent.
 */
const mode = ref<"use" | "edit">("use");
/**
 * Selection mode. The rows are buttons that launch (or open) on click, so
 * launching a handful one by one means every new browser window covers the next
 * row. In this mode a click toggles a checkbox instead, and one action launches
 * the whole selection into a single layout.
 */
const selecting = ref(false);
const selected = ref<Set<string>>(new Set());

/**
 * Bulk launch on the launch face, kept apart from the edit face's selection.
 *
 * The two mean different things: on the edit face a selection feeds re-linking,
 * exporting and deletion, while on the launch face there is exactly one verb —
 * open these. Sharing one set would make picking tiles for a launch clear a
 * batch someone had lined up for export, and the faces are one switch apart.
 *
 * The bar replaces the search row in place rather than adding a row above the
 * tiles: the whole point of this face is that a click opens an account, and
 * sliding the grid down to announce a mode defeats it. Same height, same slot,
 * and nothing below moves.
 */
const picking = ref(false);
const picked = ref<Set<string>>(new Set());

const pickedIdentities = computed(() =>
  store.identities.filter((identity) => picked.value.has(identity.id)),
);
/** Only the ones not already running — the same rule the edit face's bar uses. */
const pickedLaunchable = computed(() =>
  pickedIdentities.value.filter((identity) => !store.instanceFor(identity.id)),
);

function startPicking(): void {
  picking.value = true;
}

function endPicking(): void {
  picking.value = false;
  picked.value = new Set();
}

function togglePicked(identity: Identity): void {
  const next = new Set(picked.value);
  if (next.has(identity.id)) next.delete(identity.id);
  else next.add(identity.id);
  picked.value = next;
}

const allPicked = computed(
  () =>
    activeIdentities.value.length > 0 &&
    activeIdentities.value.every((identity) => picked.value.has(identity.id)),
);

function togglePickAll(): void {
  if (allPicked.value) {
    picked.value = new Set();
    return;
  }
  picked.value = new Set(activeIdentities.value.map((identity) => identity.id));
}

/** One click on a tile picks it while picking, and opens it otherwise. */
function onTileClick(identity: Identity): void {
  if (picking.value) {
    togglePicked(identity);
    return;
  }
  void launch(identity);
}

async function launchPicked(): Promise<void> {
  const ids = pickedLaunchable.value.map((identity) => identity.id);
  if (ids.length === 0) return;
  // Same container as the edit face's batch: a launch of several accounts is
  // about a layout, not about filling the tab strip.
  await embedded.openIdentitiesInNewView(ids);
  endPicking();
  emit("launched");
}

async function launchPickedExternal(engineId: string): Promise<void> {
  const ids = pickedLaunchable.value.map((identity) => identity.id);
  if (ids.length === 0) return;
  await store.launchIdentities(ids, engineId);
  endPicking();
  emit("launched");
}

/**
 * The selection bar's overflow menu.
 *
 * Re-linking and exporting are occasional actions on a selection; keeping them
 * inline made the bar a row of five controls plus a sentence. The menu is
 * anchored to the `⋯` and teleports to `<body>` for the same reason every other
 * popover here does — the pane clips its own scroll area.
 */
const selectMenuOpen = ref(false);
const selectMenuRoot = ref<HTMLElement | null>(null);
const selectMenu = ref<HTMLElement | null>(null);
const selectMenuStyle = ref<Record<string, string>>({});

onClickOutside(selectMenuRoot, (event) => {
  const target = event.target;
  if (target instanceof Element && target.closest("[data-floating-panel]")) return;
  selectMenuOpen.value = false;
});

useAnchoredPanel({
  open: selectMenuOpen,
  anchor: () => selectMenuRoot.value,
  panel: selectMenu,
  style: selectMenuStyle,
  minWidth: 168,
});

/*
 * Which site the right-hand column is showing.
 *
 * The pane is a master-detail panel: the left column is the list of sites, the
 * right column is the accounts of the one selected. That is the whole reason the
 * pane can be narrow — a site's accounts occupy the right half instead of a
 * second level of an expanding list, so adding a site never makes the list
 * longer, it just adds one row.
 *
 * The selection is remembered for the session (`sessionStorage`), because
 * closing the pane and reopening it to the same site is what actually happens:
 * you come back to the same site all day. It is not persisted across restarts —
 * a site that no longer exists would leave the pane on an empty right side.
 */
const STORAGE_KEY = "ensemble.identities.selectedSite";
const selectedSiteId = ref<string>(readSelectedSite());

function readSelectedSite(): string {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * The site in the right column: the remembered one while it still exists,
 * otherwise the first site that has any accounts.
 *
 * Falling back to "the first site" rather than "nothing" matters on first open:
 * a pane whose right half is empty until you click reads as broken, and the
 * first site is the one the user would have clicked anyway.
 */
const activeSiteId = computed<string>(() => {
  const groupsNow = groups.value;
  if (groupsNow.length === 0) return "";
  const remembered = groupsNow.find((group) => group.siteId === selectedSiteId.value);
  if (remembered) return remembered.siteId;
  const withPeople = groupsNow.find((group) => group.people.length > 0);
  return (withPeople ?? groupsNow[0] ?? null)?.siteId ?? "";
});

const activeGroup = computed(
  () => groups.value.find((group) => group.siteId === activeSiteId.value) ?? null,
);

/**
 * The accounts the right column is actually showing.
 *
 * Selection and the pick bar both mean "these accounts", and with one site on
 * screen that is the open site's accounts — not every account that matched the
 * search. A batch that quietly included a folded site's accounts would launch
 * pages the user could not see while picking them.
 */
const activeIdentities = computed(() => activeGroup.value?.people ?? []);

function selectSite(siteId: string): void {
  selectedSiteId.value = siteId;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, siteId);
  } catch {
    // A blocked storage must not break navigation; the click still works.
  }
}

/*
 * Selecting a site clears the batch.
 *
 * The batch is "these accounts, from this site"; carrying ticks across a site
 * change would leave the bar counting accounts the right column no longer shows,
 * and launching would open pages the user can no longer see checked.
 */
function selectSiteAndReset(siteId: string): void {
  if (siteId !== activeSiteId.value) {
    endSelecting();
    endPicking();
  }
  selectSite(siteId);
}

/**
 * Accounts "全选可见" reaches.
 *
 * A folded group's cards are not on screen, so counting them as visible would
 * make the label lie: the button says "select visible" and the user cannot see
 * what it picked. Accounts picked while their group was open stay picked — the
 * selection set is independent of what is drawn.
 */
/**
 * Accounts "全选可见" reaches.
 *
 * Only the accounts drawn in the right column: the left column shows sites, so
 * "everything visible" means the open site. Selecting a different site clears
 * the set (see `selectSiteAndReset`), so the two can never disagree.
 */
const selectableIdentities = computed(() => activeIdentities.value);

const allSelected = computed(
  () =>
    selectableIdentities.value.length > 0 &&
    selectableIdentities.value.every((identity) => selected.value.has(identity.id)),
);

const notRunningSelected = computed(() =>
  visibleIdentities.value.filter(
    (identity) => selected.value.has(identity.id) && !store.instanceFor(identity.id),
  ),
);

function toggleSelected(identityId: string) {
  // A new Set per change: Vue cannot see mutations of the same Set object.
  const next = new Set(selected.value);
  if (next.has(identityId)) next.delete(identityId);
  else next.add(identityId);
  selected.value = next;
}

function toggleAll() {
  selected.value = allSelected.value
    ? new Set()
    : new Set(selectableIdentities.value.map((identity) => identity.id));
}

function startSelecting() {
  selecting.value = true;
}

/**
 * 新建入口：一个 `+`，点开再选建什么。
 *
 * 原来有两个并列的写入口——标题栏里一个「新建账号」主按钮、旁边一个地球图标
 * 建站点。两个按钮争同一个位置的主次，而它们其实是同一件事的两个分支：往这份
 * 清单里加东西。合成一个 `+` 之后操作行只有一个焦点，标题栏也不再因为「编辑面
 * 才有写操作」而在切换时改宽度。
 *
 * 面板里用文字行而不是图标：账号和站点是两个实体，地球图标既可能是「站点」也可能
 * 被读成「打开网页」，此时文字比图形省一次辨认。
 */
const createOpen = ref(false);
const createRoot = ref<HTMLElement | null>(null);
const createPanel = ref<HTMLElement | null>(null);
const createPanelStyle = ref<Record<string, string>>({});

onClickOutside(createRoot, (event) => {
  const target = event.target;
  if (target instanceof Element && target.closest("[data-floating-panel]")) return;
  createOpen.value = false;
});

useAnchoredPanel({
  open: createOpen,
  anchor: () => createRoot.value,
  panel: createPanel,
  style: createPanelStyle,
  minWidth: 168,
});

function createAccount(): void {
  createOpen.value = false;
  emit("newIdentity");
}

function createSite(): void {
  createOpen.value = false;
  emit("newSite");
}

function endSelecting() {
  selecting.value = false;
  selected.value = new Set();
}

async function launchSelected() {
  const ids = notRunningSelected.value.map((identity) => identity.id);
  if (ids.length === 0) return;
  // A batch is the one launch that is about a layout, so it gets its own
  // container instead of scattering pages into the tab strip.
  await embedded.openIdentitiesInNewView(ids);
  endSelecting();
  emit("launched");
}

/**
 * The same selection, tiled across real windows.
 *
 * A batch external launch is a fidelity check of an arrangement, so it uses the
 * workspace layout and the same tiling a saved view would — otherwise "compare
 * these six in an external browser" would open six stacked windows.
 */
async function launchSelectedExternal(engineId: string) {
  const ids = notRunningSelected.value.map((identity) => identity.id);
  if (ids.length === 0) return;
  await store.launchIdentities(ids, engineId);
  endSelecting();
  emit("launched");
}

/**
 * Turns the selection into a saved view.
 *
 * Launching a batch already opens a container, but that container is scratch:
 * it is named by the surface and gone from the workspace once closed. The
 * question after picking six accounts is often "this is the group I keep coming
 * back to" — so the selection also routes into the view form, where it gets a
 * name, a layout and a place in the views page.
 */
/** Site choices for the batch re-link dialog. */
const siteOptions = computed(() =>
  store.sites.map((site) => ({
    value: site.id,
    label: site.name,
    hint: site.baseUrl,
  })),
);

/** The site picked in the link dialog, before it is confirmed. */
const linkSiteId = ref<string | undefined>(undefined);
const linkOpen = ref(false);

function openLinkSite() {
  if (selected.value.size === 0) return;
  // Default to the site most of the selection already belongs to, so the common
  // case (fixing one or two strays) needs no choice at all.
  const counts = new Map<string, number>();
  for (const identity of store.identities) {
    if (!selected.value.has(identity.id) || !identity.siteId) continue;
    counts.set(identity.siteId, (counts.get(identity.siteId) ?? 0) + 1);
  }
  const majority = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  linkSiteId.value = majority ?? store.defaultSite?.id;
  linkOpen.value = true;
}

/**
 * Points every selected account at the confirmed site.
 *
 * Confirmation is the point of the dialog: this write moves credentials' home
 * site for a whole batch, and an accidental click on a dropdown row was one
 * stray pointer away from doing it silently.
 */
async function confirmLinkSite() {
  const siteId = linkSiteId.value;
  if (!siteId || selected.value.size === 0) return;
  const result = await store.linkIdentitiesToSite([...selected.value], siteId);
  if (!result) return;
  linkOpen.value = false;
  endSelecting();
}

const roleVar = (color: RoleColor) => `var(--role-${color})`;

/*
 * Sharing the selected accounts with a colleague.
 *
 * This is not the settings → Data export: that one migrates the whole workspace
 * (sites, views, layouts, ids). Here the point is "these three tenant logins",
 * so the selection is the payload and the receiver matches them by URL and
 * username in their own workspace.
 */
const exportOpen = ref(false);
const exportPassphrase = ref("");
const exportError = ref("");
const exporting = ref(false);

function openExport(): void {
  exportError.value = "";
  exportOpen.value = true;
}

async function doExport(): Promise<void> {
  exportError.value = "";
  const passphrase = exportPassphrase.value;
  if (passphrase && passphrase.length < 8) {
    exportError.value = t("app.accountsExportPassTooShort");
    return;
  }
  exporting.value = true;
  try {
    const ids = [...selected.value];
    // Sites are derived from the accounts, so the receiver gets somewhere to
    // attach them without the sender having to pick sites separately.
    const result = await window.ensemble.exportAccounts({
      siteIds: [],
      identityIds: ids,
      ...(passphrase ? { passphrase } : {}),
    });
    if (result.canceled) return;
    store.notify(
      t("app.accountsExportDone", {
        accounts: result.counts?.accounts ?? ids.length,
        sites: result.counts?.sites ?? 0,
      }),
      "success",
    );
    exportOpen.value = false;
    exportPassphrase.value = "";
    endSelecting();
  } catch (error) {
    exportError.value = (error as Error).message;
  } finally {
    exporting.value = false;
  }
}

/**
 * The search term, matched against accounts *and* their site.
 *
 * Account names repeat across sites — "管理员" exists on every system — so a
 * name-only search answers a question nobody asked ("which of these twelve
 * 管理员"). Matching the site name too makes "订单" narrow to that system's
 * accounts, which is how people actually remember where an account lives. Both
 * terms are tried together rather than being separate search modes: no one has to
 * decide which kind of search they are doing.
 */
const matchesTerm = (identity: Identity, term: string): boolean => {
  if (
    identity.name.toLowerCase().includes(term) ||
    identity.username.toLowerCase().includes(term) ||
    identity.role.toLowerCase().includes(term)
  ) {
    return true;
  }
  const site = store.sites.find((item) => item.id === identity.siteId);
  return Boolean(
    site &&
      (site.name.toLowerCase().includes(term) || site.baseUrl.toLowerCase().includes(term)),
  );
};

const visibleIdentities = computed(() => {
  const term = query.value.trim().toLowerCase();
  if (!term) return store.identities;
  return store.identities.filter((identity) => matchesTerm(identity, term));
});

/**
 * One section per site, in stored site order.
 *
 * The section header is the site: name, address, account count, the groups it is
 * filed under, and the controls that edit or delete the site itself. A site with
 * no accounts still gets a section — that is how a freshly created site appears
 * before its first account exists, and hiding it would make "create a site" look
 * like it had failed.
 */
const groups = computed(() => {
  const result: Array<{
    siteId: string;
    name: string;
    url: string;
    site?: Site;
    people: Identity[];
    total: number;
  }> = [];
  for (const site of store.sites) {
    const people = visibleIdentities.value.filter((identity) => identity.siteId === site.id);
    const total = store.identities.filter((identity) => identity.siteId === site.id).length;
    // While searching, a site with no matching account is not an answer to
    // "where is this" — unless its name or address matched, which
    // `listedGroups` decides from the outside.
    if (people.length === 0 && termActive.value) continue;
    result.push({
      siteId: site.id,
      name: site.name,
      url: site.baseUrl,
      site,
      people,
      total,
    });
  }
  const orphans = visibleIdentities.value.filter(
    (identity) => !store.sites.some((site) => site.id === identity.siteId),
  );
  if (orphans.length > 0) {
    result.push({
      siteId: "__orphan__",
      name: t("app.identityOrphanSite"),
      url: "",
      people: orphans,
      total: orphans.length,
    });
  }
  /*
   * Name order, with the "no site" bucket last.
   *
   * Sorting here rather than in the stored array keeps the write path untouched
   * and means a rename re-sorts the list immediately. The orphan bucket is not a
   * site, so it goes after them rather than taking its turn alphabetically.
   */
  return result.sort((a, b) => {
    if (a.siteId === "__orphan__") return 1;
    if (b.siteId === "__orphan__") return -1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
});

const termActive = computed(() => query.value.trim().length > 0);

/**
 * The sites the left column lists.
 *
 * A site survives the search if either it matches by name or address, or one of
 * its accounts does. Both halves matter and they are the same question from
 * different ends: "which site is the ops console" is a site search, and "where
 * is review" is an account search whose answer is a site. Splitting them into
 * two fields would make the user choose a kind of search before typing.
 */
const listedGroups = computed(() => {
  const term = query.value.trim().toLowerCase();
  if (!term) return groups.value;
  return groups.value.filter(
    (group) =>
      group.name.toLowerCase().includes(term) ||
      group.url.toLowerCase().includes(term) ||
      group.people.length > 0,
  );
});


const statusLabel = (identity: Identity): string => {
  if (store.instanceFor(identity.id)) return t("app.statusRunning");
  if (identity.status === "expired") return t("app.statusExpired");
  if (identity.status === "signed-in") return formatRelative(identity.lastCheckedAt);
  return t("app.statusUnchecked");
};

function formatRelative(iso?: string): string {
  if (!iso) return t("app.statusUnchecked");
  const delta = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return t("app.justNow");
  if (minutes < 60) return t("app.minutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("app.hoursAgo", { count: hours });
  return t("app.daysAgo", { count: Math.floor(hours / 24) });
}

async function launch(identity: Identity) {
  if (selecting.value) {
    toggleSelected(identity.id);
    return;
  }
  await launchHere(identity);
}

/**
 * What a click on the row body does.
 *
 * Two meanings, chosen by what the row itself is: in selection mode it is a
 * checkbox, and otherwise it launches. It used to open the account form when the
 * account was not running — which put a low-frequency action (editing a saved
 * account) behind the row's only large target and pushed the frequent one
 * (opening the page) onto a small control at the far right. A list of accounts
 * exists to open them; editing is a maintenance act with its own pencil.
 *
 * A running account raises its window instead of opening a second page: there is
 * one page per account in the built-in surface, and asking for it again means
 * "bring me the one I have".
 */
function onCardClick(identity: Identity): void {
  if (selecting.value) {
    toggleSelected(identity.id);
    return;
  }
  launch(identity);
}

/**
 * The plain click: a page in the built-in surface.
 *
 * Built-in means "a new tab in the default tab strip", always — even when a view
 * is on stage or the account is already running somewhere. Clicking a card is a
 * request for that page, not an instruction to rearrange the stage; moving into
 * a view is the drag gesture or the view's own "add tab".
 *
 * The split control's arrow is the other half: it opens the browser list, so the
 * fidelity check is one click away instead of being a mode set somewhere else.
 */
async function launchHere(identity: Identity): Promise<void> {
  await embedded.openIdentity(identity.id);
  emit("launched");
}

/**
 * The same account in an external browser.
 *
 * External windows exist once per identity, so launching again raises the
 * running one rather than opening a second window that would fight it for the
 * same profile directory.
 */
async function launchExternal(identity: Identity, engineId: string): Promise<void> {
  if (selecting.value) return;
  const instance = store.instanceFor(identity.id);
  if (instance) {
    await store.focusInstance(instance.id);
    emit("launched");
    return;
  }
  await store.launchIdentity(identity.id, undefined, engineId);
  emit("launched");
}

async function relogin(identity: Identity) {
  const instance = store.instanceFor(identity.id);
  if (instance) {
    // Raising the window is not relogin: the fill has to be asked for.
    await store.fillLogin(identity.id);
    return;
  }
  // The embedded surface has no login page to submit; opening the identity's
  // start page and filling it is the equivalent action, and it is the surface
  // the card's own click opens, so "重新登录" follows it.
  await embedded.openIdentity(identity.id);
}

async function checkAuth(identity: Identity) {
  await store.checkAuth(identity.id);
}

function passwordLabel(identity: Identity): string {
  if (identity.passwordMode === "reference") return t("app.passwordReferenced");
  if (!store.identityPasswordSet(identity)) return t("app.passwordNotSet");
  return identity.passwordMode === "custom" ? t("app.passwordCustom") : t("app.passwordInherit");
}

/**
 * The facts the card folds into "+N".
 *
 * Only things a user set on purpose: a browser that differs from the default,
 * and each extra login field by its label. The list is also the chip's tooltip,
 * so folding them never hides what they are — it only stops them from reflowing
 * the grid.
 */
function extraFacts(identity: Identity): string[] {
  const facts: string[] = [];
  const brand = identity.engineId ? store.engineFor(identity)?.brand : undefined;
  if (brand) facts.push(brand);
  for (const field of identity.extraFields ?? []) facts.push(field.label);
  return facts;
}

/*
 * Sites are listed in name order, not by a stored order.
 *
 * They used to reorder by dragging a grip, which meant the list remembered a
 * sequence nobody could reason about: two sites created minutes apart sat in
 * creation order, and finding one meant scanning. Alphabetical order is the same
 * list for everyone, survives a rename, and needs no handle, no drop target and
 * no "where did it go" after a drag. Sorting happens in `groups`, so the stored
 * array order is left alone and nothing migrates.
 *
 * Accounts keep their stored order: they are a handful per site and their order
 * is whatever the user created, which is the useful order.
 */

/** Switching to the tile face ends any selection: the bar belongs to edit. */
function setMode(next: "use" | "edit"): void {
  mode.value = next;
  // Each face's selection belongs to that face. Leaving one behind means coming
  // back to ticks the user did not make in this visit — and the edit face's ticks
  // arm actions (re-link, export) that a stray set would fire on.
  endSelecting();
  endPicking();
}

/*
 * The face switch belongs to the pane's head, not to the page body: it chooses
 * which face of the pane is showing, which is a fact about the pane. So the pane
 * owns the control and this page owns the state — the pane calls down through
 * these.
 */
defineExpose({ mode, setMode });
</script>

<template>
  <section class="page identities" :data-mode="mode">
    <!--
      A bar, not a title.

      The pane is opened from a button that already says "多账号", so a heading
      repeating it — and a subtitle repeating the count that the filter tabs
      already carry — is two lines of text to read on every visit that answer
      nothing. What the bar holds instead is the two things that are not
      repeated anywhere else: the face switch on the left, the write actions on
      the right.

      The switch is pinned left on purpose. It used to sit with the actions, so
      switching to the edit face pushed it a hundred pixels left when two buttons
      appeared beside it — a control that moves when you use it.
    -->
    <div v-if="store.credentials?.warning" class="vault-banner">
      {{ store.credentials.warning }}
    </div>

    <!-- Choosing the target site is a dialog, not a dropdown in the bar: the
         write moves a whole batch's home site, so it gets an explicit confirm. -->
    <Modal
      :open="linkOpen"
      :title="$t('app.batchLinkSiteTitle')"
      :description="$t('app.batchLinkSiteDesc', { count: selected.size })"
      width="440px"
      @close="linkOpen = false"
    >
      <label class="link-field">
        <span class="label">{{ $t("app.identitySite") }}</span>
        <SelectField
          v-model="linkSiteId"
          :options="siteOptions"
          :placeholder="$t('app.identitySitePick')"
          :aria-label="$t('app.identitySite')"
        />
      </label>
      <template #footer>
        <span class="spacer"></span>
        <AppButton @click="linkOpen = false">{{ $t("app.cancel") }}</AppButton>
        <AppButton
          variant="primary"
          data-confirm-link-site
          :disabled="!linkSiteId || store.busy === 'identity'"
          @click="confirmLinkSite"
        >
          {{ $t("app.batchLinkSiteConfirm") }}
        </AppButton>
      </template>
    </Modal>

    <!-- Sharing a selection has one extra input — a passphrase — and that is
         enough to make it a dialog: an inline strip pushed the card grid down
         while it was open and lost the context of what was being shared. -->
    <Modal
      :open="exportOpen"
      :title="$t('app.accountsExportTitle')"
      :description="$t('app.accountsExportNote', { count: selected.size })"
      width="460px"
      @close="exportOpen = false"
    >
      <FormField :label="$t('app.accountsExportPassphrase')">
        <TextField
          v-model="exportPassphrase"
          type="password"
          autocomplete="new-password"
          :placeholder="$t('app.accountsExportPassphraseHint')"
        />
      </FormField>
      <p v-if="exportError" class="error" role="alert">{{ exportError }}</p>
      <template #footer>
        <span class="spacer"></span>
        <AppButton @click="exportOpen = false">{{ $t("app.cancel") }}</AppButton>
        <AppButton variant="primary" :disabled="exporting" @click="doExport">
          {{ exportPassphrase ? $t("app.accountsExportWithPassword") : $t("app.accountsExportPlain") }}
        </AppButton>
      </template>
    </Modal>

    <!-- The global identities' "one more": a name, and it joins the list. -->
    <Modal
      :open="identityCreateOpen"
      :title="renameTarget ? $t('app.sessionRename') : $t('app.identityNew')"
      width="380px"
      @close="closeIdentityDialog"
    >
      <form @submit.prevent="renameTarget ? submitIdentityRename() : submitIdentity()">
        <FormField :label="$t('app.sessionNameLabel')">
          <TextField
            v-model="identityName"
            type="text"
            maxlength="60"
            :placeholder="$t('app.sessionNamePlaceholder')"
            data-identity-name
          />
        </FormField>
        <p v-if="identityError" class="error" role="alert">{{ identityError }}</p>
      </form>
      <template #footer>
        <span class="spacer"></span>
        <AppButton @click="closeIdentityDialog">{{ $t("app.cancel") }}</AppButton>
        <AppButton
          variant="primary"
          data-identity-create
          @click="renameTarget ? submitIdentityRename() : submitIdentity()"
        >
          {{ renameTarget ? $t("app.save") : $t("app.sessionCreate") }}
        </AppButton>
      </template>
    </Modal>

    <!--
      The launch face: master and detail, side by side.

      The left column is the list of places a page can start — global identities
      first, then the sites — and the right column is the accounts of whichever
      one is selected. This replaced a single scrolling list with every site
      expanded:
      with a dozen sites the pane was one long scroll where the site you wanted
      was off screen, and every site's tiles competed with every other site's.

      Master-detail is also what lets the pane be narrow. A site costs one row in
      the left column no matter how many accounts it has, so the pane's width is
      decided by the widest single list row plus the widest tile, not by the whole
      workspace.
    -->
    <div v-if="mode === 'use'" class="split-face" data-tile-face>
      <div class="split-nav" data-split-nav>
        <!--
          The search sits above the list it filters.

          It used to live in the right column, over the accounts, which said by
          position that it searches accounts — and the thing people actually
          search for here is the site ("where is the ops console"). From the top
          of the left column it reads as filtering the list below it, which is
          both what it does and what makes a site search discoverable.
        -->
        <label class="nav-search">
          <Search :size="12" />
          <input v-model="query" type="search" :placeholder="$t('app.searchSitesOrAccounts')" />
        </label>
        <!--
          Global identities, at the top of the left column.

          They are the first level of the same question the sites answer: which
          jar the page opens in. They belong to no site, so they sit above the
          site list rather than inside it — and launching one opens a blank page
          in that jar, because a page with no site has nowhere to navigate to.

          The group's own "+" creates another one. Creating one used to live on a
          settings page, which meant leaving the browser, making a row, and coming
          back to find it; the list that answers "which jars do I have" is where
          the question "one more" belongs.
        -->
        <div class="nav-head">
          <span>{{ $t("app.identitiesGlobal") }}</span>
          <button
            type="button"
            class="nav-add"
            :aria-label="$t('app.identityNew')"
            :title="$t('app.identityNew')"
            data-new-identity
            @click="openCreateIdentity"
          >
            <Plus :size="11" />
          </button>
        </div>
        <button
          v-for="profile in persistentProfiles"
          :key="profile.id"
          type="button"
          class="nav-row"
          :class="{ current: profile.id === defaultProfileId }"
          :data-launch-session="profile.id"
          :title="profile.name"
          @click="launchSession(profile.id)"
        >
          <Layers :size="12" class="nav-icon" />
          <span class="nav-name">{{ profile.name }}</span>
        </button>
        <button
          v-if="cleanProfile"
          type="button"
          class="nav-row dashed"
          :data-launch-session="cleanProfile.id"
          :title="cleanProfile.name"
          @click="launchSession(cleanProfile.id)"
        >
          <ShieldOff :size="12" class="nav-icon" />
          <span class="nav-name">{{ cleanProfile.name }}</span>
        </button>

        <div class="nav-head nav-head-sites">
          <span>{{ $t("app.sites") }}</span>
          <!-- One `+` with two branches, the way the action row had it: an
               account and a site are two answers to "add something", and a list
               header with two buttons on it is a toolbar wearing a heading. -->
          <span ref="createRoot" class="create-root">
            <button
              type="button"
              class="nav-add"
              :class="{ on: createOpen }"
              :aria-label="$t('app.createEntry')"
              :title="$t('app.createEntry')"
              :aria-expanded="createOpen"
              aria-haspopup="menu"
              data-create-entry
              @click.stop="createOpen = !createOpen"
            >
              <Plus :size="11" />
            </button>
            <Teleport to="body">
              <div
                v-if="createOpen"
                ref="createPanel"
                class="create-panel"
                :style="createPanelStyle"
                role="menu"
                data-floating-panel
                data-create-panel
              >
                <button type="button" role="menuitem" class="row" data-new-account @click.stop="createAccount">
                  <Users :size="12" class="row-icon" />
                  <span>{{ $t("app.newIdentity") }}</span>
                </button>
                <button type="button" role="menuitem" class="row" data-new-site @click.stop="createSite">
                  <Globe :size="12" class="row-icon" />
                  <span>{{ $t("app.newSite") }}</span>
                </button>
              </div>
            </Teleport>
          </span>
        </div>
        <button
          v-for="group in listedGroups"
          :key="group.siteId"
          type="button"
          class="nav-row site"
          :class="{ active: group.siteId === activeSiteId }"
          :data-site-row="group.siteId"
          :title="group.name"
          @click="selectSiteAndReset(group.siteId)"
        >
          <span class="nav-name">{{ group.name }}</span>
          <span class="nav-count mono">{{ group.people.length }}</span>
        </button>
        <p v-if="!groups.length" class="nav-empty">{{ $t("app.noSitesYet") }}</p>
      </div>

      <div class="split-body" data-split-body>
        <!--
          One slot, two states: the site header, or the pick bar.

          They are the same height and occupy the same row, so turning picking on
          does not move the tiles: the next click is on a tile the eye is already
          resting on. The header's site name is carried into the bar's absence
          deliberately — while picking, "which site am I picking from" is still
          worth knowing, and the left column's highlighted row answers it.
        -->
        <div v-if="activeGroup && !picking" class="detail-head">
          <span class="detail-name">{{ activeGroup.name }}</span>
          <span v-if="activeGroup.url" class="detail-url mono">{{ activeGroup.url }}</span>
          <span class="sel-spacer"></span>
          <button
            v-if="activeGroup.people.length"
            type="button"
            class="bar-icon"
            :aria-label="$t('app.batchSelect')"
            :title="$t('app.batchSelectHint')"
            data-tile-pick
            @click="startPicking"
          >
            <CheckSquare :size="13" />
          </button>
          <template v-if="activeGroup.siteId !== '__orphan__'">
            <button
              type="button"
              class="bar-icon"
              :aria-label="$t('app.newIdentityHere')"
              :title="$t('app.newIdentityHere')"
              :data-add-identity="activeGroup.siteId"
              @click="emit('newIdentity', activeGroup.siteId)"
            >
              <Plus :size="13" />
            </button>
            <button
              type="button"
              class="bar-icon"
              :aria-label="$t('app.editThisSite')"
              :title="$t('app.editThisSite')"
              :data-edit-site="activeGroup.siteId"
              @click="emit('editSite', activeGroup.siteId)"
            >
              <Pencil :size="12" />
            </button>
          </template>
        </div>

        <div v-else-if="picking" class="pick-bar" data-pick-bar>
          <span class="sel-count mono">{{ $t("app.batchSelected", { count: picked.size }) }}</span>
          <button type="button" class="pick-all" @click="togglePickAll">
            {{ allPicked ? $t("app.batchClearAll") : $t("app.batchSelectAll") }}
          </button>
          <span class="sel-spacer"></span>
          <LaunchSplitButton
            variant="primary"
            :label="$t('app.batchLaunch', { count: pickedLaunchable.length })"
            :disabled="!pickedLaunchable.length || store.busy === 'launch'"
            data-hook="pick"
            @launch="launchPicked"
            @launch-external="launchPickedExternal"
          />
          <button
            type="button"
            class="bar-icon"
            :aria-label="$t('app.cancel')"
            :title="$t('app.cancel')"
            data-pick-cancel
            @click="endPicking"
          >
            <X :size="14" />
          </button>
        </div>

        <div class="split-scroll" data-tile-scroll>
          <div v-if="activeGroup && activeGroup.people.length" class="tiles">
            <button
              v-for="identity in activeGroup.people"
              :key="identity.id"
              type="button"
              class="tile"
              :class="{
                running: Boolean(store.instanceFor(identity.id)),
                picking: picking,
                picked: picking && picked.has(identity.id),
              }"
              :style="{ '--role': roleVar(identity.color) }"
              :data-account-tile="identity.id"
              :aria-pressed="picking ? picked.has(identity.id) : undefined"
              :title="`${identity.name} · ${identity.role}`"
              @click="onTileClick(identity)"
            >
              <span class="tile-avatar">{{ identity.name.slice(0, 1) }}</span>
              <span class="tile-text">
                <span class="tile-name">{{ identity.name }}</span>
                <span class="tile-role">{{ identity.role }}</span>
              </span>
              <!-- The pick mark is absolutely positioned, so turning picking on
                   changes no tile's size: a grid that reflows the moment you
                   enter the mode moves the target out from under the next click. -->
              <span v-if="picking" class="tile-pick" aria-hidden="true">
                <Check v-if="picked.has(identity.id)" :size="11" />
              </span>
              <span
                class="tile-dot"
                :class="{
                  live: Boolean(store.instanceFor(identity.id)),
                  expired: identity.status === 'expired',
                }"
                :aria-label="statusLabel(identity)"
              ></span>
            </button>
          </div>

          <EmptyState
            v-if="!visibleIdentities.length"
            :text="store.identities.length ? $t('app.noMatchingIdentities') : $t('app.empty')"
          >
            <template #icon><Users :size="22" /></template>
            <!--
              Both doors, not just the account one.

              The action row is hidden while the list is empty (a filter bar over
              nothing is noise), and the create menu lives on that row — so on a
              brand-new workspace the only way to add a site would be to add an
              account first, which is backwards: an account belongs to a site.
              The empty state therefore offers both, and this is the one place
              where spelling them out beats a `+` menu.
            -->
            <div class="empty-actions">
              <AppButton variant="primary" data-new-account @click="emit('newIdentity', activeSiteId || undefined)">
                <Plus :size="13" />
                {{ $t("app.newIdentity") }}
              </AppButton>
              <AppButton data-new-site @click="emit('newSite')">
                <Globe :size="13" />
                {{ $t("app.newSite") }}
              </AppButton>
            </div>
          </EmptyState>
          <p
            v-else-if="activeGroup && !activeGroup.people.length"
            class="detail-empty"
            data-detail-empty
          >
            {{ $t("app.noAccountsInSite") }}
          </p>
        </div>
      </div>
    </div>

    <!--
      The edit face: the same master-detail split, with the table on the right.

      One site per visit is the right shape here too. Every write an account row
      offers — stop, relaunch, check, edit — is about that account; a table of
      every account in the workspace made the reader scroll past four sites to
      reach the fifth, and made the column widths a compromise between all of
      them.
    -->
    <div v-else class="split-face" data-tile-face>
      <div class="split-nav" data-split-nav>
        <label class="nav-search">
          <Search :size="12" />
          <input v-model="query" type="search" :placeholder="$t('app.searchSitesOrAccounts')" />
        </label>
        <!--
          The edit face's global group: the same list as the launch face, with the
          writes that belong to it — rename, make default, delete, one more.

          These lived on a settings page of their own. A settings page is where you
          go to change how the app behaves; an identity is a thing you browse as,
          so its row belongs beside the sites it opens and the accounts it opens
          them as.
        -->
        <div class="nav-head">
          <span>{{ $t("app.identitiesGlobal") }}</span>
          <button
            type="button"
            class="nav-add"
            :aria-label="$t('app.identityNew')"
            :title="$t('app.identityNew')"
            data-new-identity
            @click="openCreateIdentity"
          >
            <Plus :size="11" />
          </button>
        </div>
        <div
          v-for="profile in persistentProfiles"
          :key="profile.id"
          class="nav-row identity-row"
          :class="{ current: profile.id === defaultProfileId }"
          :data-identity-row="profile.id"
        >
          <Layers :size="12" class="nav-icon" />
          <span class="nav-name">{{ profile.name }}</span>
          <span
            v-if="profile.id === defaultProfileId"
            class="identity-badge"
          >{{ $t("app.sessionDefaultBadge") }}</span>
          <span class="identity-actions">
            <button
              v-if="profile.id !== defaultProfileId"
              type="button"
              class="row-action"
              :aria-label="$t('app.sessionSetDefault')"
              :title="$t('app.sessionSetDefault')"
              :data-identity-default="profile.id"
              @click.stop="store.setDefaultProfile(profile.id)"
            >
              <Star :size="11" />
            </button>
            <button
              v-if="!profile.builtin"
              type="button"
              class="row-action"
              :aria-label="$t('app.sessionRename')"
              :title="$t('app.sessionRename')"
              :data-identity-rename="profile.id"
              @click.stop="openRenameIdentity(profile)"
            >
              <Pencil :size="11" />
            </button>
            <button
              v-if="!profile.builtin"
              type="button"
              class="row-action danger"
              :aria-label="$t('app.sessionDeleteTitle')"
              :title="$t('app.sessionDeleteTitle')"
              :data-identity-delete="profile.id"
              @click.stop="removeIdentity(profile)"
            >
              <Trash2 :size="11" />
            </button>
          </span>
        </div>
        <div v-if="cleanProfile" class="nav-row identity-row dashed" :data-identity-row="cleanProfile.id">
          <ShieldOff :size="12" class="nav-icon" />
          <span class="nav-name">{{ cleanProfile.name }}</span>
        </div>

        <div class="nav-head nav-head-sites">
          <span>{{ $t("app.sites") }}</span>
          <!-- One `+` with two branches, the way the action row had it: an
               account and a site are two answers to "add something", and a list
               header with two buttons on it is a toolbar wearing a heading. -->
          <span ref="createRoot" class="create-root">
            <button
              type="button"
              class="nav-add"
              :class="{ on: createOpen }"
              :aria-label="$t('app.createEntry')"
              :title="$t('app.createEntry')"
              :aria-expanded="createOpen"
              aria-haspopup="menu"
              data-create-entry
              @click.stop="createOpen = !createOpen"
            >
              <Plus :size="11" />
            </button>
            <Teleport to="body">
              <div
                v-if="createOpen"
                ref="createPanel"
                class="create-panel"
                :style="createPanelStyle"
                role="menu"
                data-floating-panel
                data-create-panel
              >
                <button type="button" role="menuitem" class="row" data-new-account @click.stop="createAccount">
                  <Users :size="12" class="row-icon" />
                  <span>{{ $t("app.newIdentity") }}</span>
                </button>
                <button type="button" role="menuitem" class="row" data-new-site @click.stop="createSite">
                  <Globe :size="12" class="row-icon" />
                  <span>{{ $t("app.newSite") }}</span>
                </button>
              </div>
            </Teleport>
          </span>
        </div>
        <button
          v-for="group in listedGroups"
          :key="group.siteId"
          type="button"
          class="nav-row site"
          :class="{ active: group.siteId === activeSiteId }"
          :data-site-row="group.siteId"
          :title="group.name"
          @click="selectSiteAndReset(group.siteId)"
        >
          <span class="nav-name">{{ group.name }}</span>
          <span class="nav-count mono">{{ group.people.length }}</span>
        </button>
        <p v-if="!groups.length" class="nav-empty">{{ $t("app.noSitesYet") }}</p>
      </div>

      <div class="split-body" data-split-body>
        <div v-if="selecting" class="select-bar">
          <span class="sel-count mono">
            {{ $t("app.batchSelected", { count: selected.size }) }}
          </span>
          <AppButton class="sel-all" @click="toggleAll">
            {{ allSelected ? $t("app.batchClearAll") : $t("app.batchSelectAll") }}
          </AppButton>
          <span class="sel-spacer"></span>
          <LaunchSplitButton
            variant="primary"
            :label="$t('app.batchLaunch', { count: notRunningSelected.length })"
            :disabled="!notRunningSelected.length || store.busy === 'launch'"
            data-hook="batch"
            @launch="launchSelected"
            @launch-external="launchSelectedExternal"
          />
          <span ref="selectMenuRoot" class="sel-more">
            <button
              type="button"
              class="bar-icon"
              :class="{ on: selectMenuOpen }"
              :aria-label="$t('app.batchMore')"
              :title="$t('app.batchMore')"
              :aria-expanded="selectMenuOpen"
              aria-haspopup="menu"
              data-batch-more
              @click.stop="selectMenuOpen = !selectMenuOpen"
            >
              <MoreHorizontal :size="14" />
            </button>
          </span>
          <button
            type="button"
            class="bar-icon"
            :aria-label="$t('app.cancel')"
            :title="$t('app.cancel')"
            data-batch-cancel
            @click="endSelecting"
          >
            <X :size="14" />
          </button>

          <!-- Re-linking and exporting are occasional actions on a selection;
               behind `⋯` they stop reading as peers of "launch". Teleported to
               the body because the pane clips its own scroll area. -->
          <Teleport to="body">
            <div
              v-if="selectMenuOpen"
              ref="selectMenu"
              class="select-menu"
              :style="selectMenuStyle"
              role="menu"
              data-floating-panel
              data-batch-menu
            >
              <button
                type="button"
                role="menuitem"
                class="row"
                :disabled="selected.size === 0"
                data-batch-link-site
                @click.stop="
                  selectMenuOpen = false;
                  openLinkSite();
                "
              >
                <Link2 :size="12" class="row-icon" />
                <span>{{ $t("app.batchLinkSite") }}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                class="row"
                :disabled="selected.size === 0"
                data-batch-export
                @click.stop="
                  selectMenuOpen = false;
                  openExport();
                "
              >
                <Download :size="12" class="row-icon" />
                <span>{{ $t("app.accountsExport") }}</span>
              </button>
            </div>
          </Teleport>
        </div>

        <!-- The site's own header: name, address, and everything that acts on it.
             It gives up its row while selecting — the bar carries the count and
             the actions, and the left column still marks which site is open. -->
        <div v-if="activeGroup && !selecting" class="detail-head">
          <span class="detail-name">{{ activeGroup.name }}</span>
          <span v-if="activeGroup.url" class="detail-url mono">{{ activeGroup.url }}</span>
          <span class="sel-spacer"></span>
          <!-- The two list-wide actions live here, beside the site they act on:
               the batch door and the health sweep. They used to have a 30px
               row of their own, which was one icon and a lot of empty width. -->
          <button
            v-if="selectableIdentities.length"
            type="button"
            class="bar-icon"
            :aria-label="$t('app.batchSelect')"
            :title="$t('app.batchSelectHint')"
            data-batch-select
            @click="startSelecting"
          >
            <CheckSquare :size="13" />
          </button>
          <button
            type="button"
            class="bar-icon"
            :aria-label="$t('app.sessionHealth')"
            :title="$t('app.sessionHealth')"
            data-session-health
            @click="emit('sessionHealth')"
          >
            <HeartPulse :size="13" />
          </button>
          <template v-if="activeGroup.siteId !== '__orphan__'">
            <button
              type="button"
              class="bar-icon"
              :aria-label="$t('app.newIdentityHere')"
              :title="$t('app.newIdentityHere')"
              :data-add-identity="activeGroup.siteId"
              @click="emit('newIdentity', activeGroup.siteId)"
            >
              <Plus :size="13" />
            </button>
            <button
              type="button"
              class="bar-icon"
              :aria-label="$t('app.editThisSite')"
              :title="$t('app.editThisSite')"
              :data-edit-site="activeGroup.siteId"
              @click="emit('editSite', activeGroup.siteId)"
            >
              <Pencil :size="12" />
            </button>
          </template>
        </div>
        <div class="split-scroll" data-tile-scroll>
          <div class="cards">
            <template v-if="activeGroup">
              <div
                class="id-table-head"
                :class="{ picking: selecting }"
                aria-hidden="true"
              >
                <span v-if="selecting"></span>
                <span>{{ $t("app.columnAccount") }}</span>
                <span>{{ $t("app.columnRolePassword") }}</span>
                <span>{{ $t("app.status") }}</span>
                <span class="table-head-actions">{{ $t("app.columnActions") }}</span>
              </div>
              <!--
                A `div` with a button role, not a `<button>`.

                The row now carries a real launch control, and a `<button>` cannot
                contain one — the parser would close the row at the inner button's
                tag and the actions would fall outside it. The role and the key
                handlers keep everything a button gave us: a tab stop, Enter and
                Space activating the row itself, and `aria-pressed` in selection
                mode.
              -->
              <div
                v-for="(identity, index) in activeGroup.people"
                :key="identity.id"
                class="id-card"
                :class="{
                  running: Boolean(store.instanceFor(identity.id)),
                  picking: selecting,
                  picked: selected.has(identity.id),
                  last: index === activeGroup.people.length - 1,
                }"
                :style="{ '--role': roleVar(identity.color) }"
                role="button"
                tabindex="0"
                :aria-pressed="selecting ? selected.has(identity.id) : undefined"
                @click="onCardClick(identity)"
                @keydown.enter.prevent="onCardClick(identity)"
                @keydown.space.prevent="onCardClick(identity)"
              >
                <!-- Selection mode hides the per-row actions: in that mode the row
                     is a checkbox, and stop/relaunch/edit would fire from a
                     mis-aimed click. -->
                <span v-if="selecting" class="pick-mark" :class="{ on: selected.has(identity.id) }">
                  <Check v-if="selected.has(identity.id)" :size="11" />
                </span>
                <div class="card-top">
                  <span class="avatar">{{ identity.name.slice(0, 1) }}</span>
                  <span class="who">
                    <span class="name">{{ identity.name }}</span>
                    <span class="acct mono">{{ identity.username }}</span>
                  </span>
                </div>

                <!--
                  Two facts always, the rest counted.

                  Every account answers "which role" and "is a password stored" —
                  those are what a list of accounts is compared on, so they always
                  get a chip. Everything else (a non-default browser, extra login
                  fields) folds into one "+N" chip whose tooltip names them.
                -->
                <div class="meta-row">
                  <span class="tag tag-role" :title="identity.role">{{ identity.role }}</span>
                  <span class="tag plain" :class="{ missing: !store.identityPasswordSet(identity) }">
                    {{ passwordLabel(identity) }}
                  </span>
                  <span
                    v-if="extraFacts(identity).length"
                    class="tag plain more"
                    :title="extraFacts(identity).join(' · ')"
                    :aria-label="extraFacts(identity).join(' · ')"
                  >
                    +{{ extraFacts(identity).length }}
                  </span>
                </div>

                <span
                  class="state mono"
                  :class="{
                    live: Boolean(store.instanceFor(identity.id)),
                    warn: identity.status === 'expired',
                  }"
                  :title="statusLabel(identity)"
                >
                  <span class="dot"></span>{{ statusLabel(identity) }}
                </span>

                <!--
                  The row's actions, in two groups.

                  One row, five actions, one visual form: all of them are icon
                  buttons with a tooltip. Mixed text and glyphs in the same cluster
                  read as debris, and a text action is also twice as wide as it
                  needs to be for a verb the user learns once. Icons also let every
                  row's actions end at the same right edge.
                -->
                <div v-if="!selecting" class="card-actions">
                  <span class="card-session">
                    <template v-if="store.instanceFor(identity.id)">
                      <IconButton
                        :ariaLabel="$t('app.switchTo')"
                        @click.stop="launch(identity)"
                      >
                        <Play :size="12" />
                      </IconButton>
                      <IconButton
                        :ariaLabel="$t('app.stop')"
                        @click.stop="store.stopInstance(store.instanceFor(identity.id)!.id)"
                      >
                        <Square :size="11" />
                      </IconButton>
                    </template>
                    <!-- The plain click is the built-in surface; the arrow lists
                         every browser the app found, so the fidelity check is a
                         decision made here instead of a mode flipped in a menu. -->
                    <LaunchSplitButton
                      v-else
                      compact
                      :aria-label="$t('app.launch')"
                      :data-hook="`launch-${identity.id}`"
                      @launch="launch(identity)"
                      @launch-external="launchExternal(identity, $event)"
                    />
                    <IconButton
                      :ariaLabel="$t('app.relaunch')"
                      @click.stop="relogin(identity)"
                    >
                      <RotateCcw :size="12" />
                    </IconButton>
                    <IconButton
                      :ariaLabel="$t('app.checkAuth')"
                      @click.stop="checkAuth(identity)"
                    >
                      <HeartPulse :size="12" />
                    </IconButton>
                  </span>
                  <span class="card-manage">
                    <IconButton
                      :ariaLabel="$t('app.edit')"
                      :data-edit-identity="identity.id"
                      @click.stop="emit('editIdentity', identity.id)"
                    >
                      <Pencil :size="12" />
                    </IconButton>
                  </span>
                </div>
                <div v-else class="card-pick-note mono">
                  {{
                    store.instanceFor(identity.id) ? $t("app.batchAlreadyRunning") : $t("app.batchWillLaunch")
                  }}
                </div>
              </div>
            </template>

            <EmptyState
              v-if="!visibleIdentities.length"
              :text="store.identities.length ? $t('app.noMatchingIdentities') : $t('app.empty')"
            >
              <template #icon><Users :size="22" /></template>
              <!-- Always the account door. A site with no accounts still needs a
                   way to get its first one, and the account form starts on the
                   site that was most recently used. -->
              <AppButton variant="primary" @click="emit('newIdentity', activeSiteId || undefined)">
                <Plus :size="13" />
                {{ $t("app.newIdentity") }}
              </AppButton>
            </EmptyState>
            <p
              v-else-if="activeGroup && !activeGroup.people.length"
              class="detail-empty"
              data-detail-empty
            >
              {{ $t("app.noAccountsInSite") }}
            </p>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/*
 * A floating pane is not a window.
 *
 * `.page`'s 24/28 padding is the mockup's full-page rhythm; at the pane's 720px
 * it puts the list 28px off the edge and leaves a band of nothing under the bar.
 * The pane's own edges already separate it from the page behind, so the content
 * only needs breathing room, not a margin.
 */
.page.identities {
  padding: 14px 16px 12px;
}

/*
 * The pane's one fixed row: face switch on the left, write actions on the right.
 *
 * It is a header rather than a `PageHeader` because a page header exists to say
 * the page's name, and this pane's name is already on the button that opened it.
 * Keeping it a single row also keeps the content's top edge still: the bar's
 * height does not change when the edit face's two buttons appear, so nothing
 * below it moves between faces.
 */
.pane-bar {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  flex: 0 0 auto;
  min-height: 30px;
  padding-bottom: 12px;
}

.pane-bar-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.vault-banner {
  margin-top: 12px;
  padding: 8px 11px;
  border-radius: var(--radius);
  font-size: 11px;
  flex: 0 0 auto;
  border: 1px solid color-mix(in srgb, var(--accent) 32%, var(--line));
  background: color-mix(in srgb, var(--accent) 7%, transparent);
  color: color-mix(in srgb, var(--accent) 78%, var(--text));
}

/*
 * One row of filtering: status tabs, the search field, then icon actions.
 *
 * `nowrap` on purpose. The row has one control of each kind plus three icons; a
 * wrap put the third icon on a line of its own, which is what made the top of the
 * pane look assembled rather than designed. The search field absorbs the slack
 * instead (`flex: 1 1 auto`), so a narrower pane shortens the field before
 * anything drops to a second line.
 */
.filter-bar {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 8px;
  margin: 0 0 10px;
  flex: 0 0 auto;
  min-width: 0;
}

.filter-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
}

/* The create door's anchor. `inline-flex` so the button inside keeps its own box
   instead of stretching to the row's height. */
.create-root {
  display: inline-flex;
}

/*
 * The create menu: two rows, no icons column.
 *
 * Placed by `useAnchoredPanel` in viewport coordinates (it teleports to `<body>`),
 * which is what lets it escape the pane's `overflow: hidden` — and the reason it
 * is unaffected by the pane's `backdrop-filter` making that box a containing
 * block for fixed descendants.
 */
.create-panel {
  position: fixed;
  pointer-events: auto;
  z-index: 90;
  min-width: 168px;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-menu);
  animation: create-panel-in var(--motion-base) var(--ease-out);
  transform-origin: top left;
}

@keyframes create-panel-in {
  from {
    opacity: 0;
    transform: translateY(calc(-1 * var(--motion-shift))) scale(var(--motion-pop-scale));
  }
}

.create-panel .row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: 11.5px;
  text-align: left;
}

.create-panel .row:hover {
  background: var(--surface-2);
  color: var(--text);
}

.create-panel .row-icon {
  flex: 0 0 auto;
  color: var(--faint);
}

/* The empty state's pair of doors: primary create, secondary site. */
.empty-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* The filter row's icon buttons: same 26px target and same quiet colour as the
   tabs beside them, so the row reads as one band of controls. */
.bar-icon {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  color: var(--faint);
}

.bar-icon:hover {
  background: color-mix(in srgb, var(--text) 8%, transparent);
  color: var(--text);
}

.bar-icon.on {
  background: var(--selected);
  color: var(--text);
}

.tabs {
  display: flex;
  gap: 2px;
  border: 1px solid var(--line-soft);
  background: var(--bg-elevated);
  border-radius: var(--radius);
  padding: 2px;
}

.tab {
  border-radius: var(--radius-sm);
  padding: 5px 9px;
  font-size: 11px;
  color: var(--muted);
  display: flex;
  align-items: center;
  gap: 6px;
}

.tab:hover {
  color: var(--text-secondary);
}

.tab.active {
  background: var(--surface-3);
  color: var(--text);
}

.num {
  font-size: 10.5px;
  color: var(--faint);
}

.tab.active .num {
  color: var(--accent-text);
}

/* The search field takes the row's slack rather than a fixed 200px: with tabs and
   three icons on the same line, a fixed width is what made the row wrap. */
.search {
  display: flex;
  align-items: center;
  gap: 7px;
  border: 1px solid var(--line-soft);
  background: var(--bg-elevated);
  border-radius: var(--radius);
  padding: 5px 9px;
  flex: 1 1 auto;
  min-width: 96px;
  color: var(--faint);
}

/*
 * One line, two ends.
 *
 * The count and "select all" state what the selection is; the launch, `⋯` and
 * `✕` are what you can do about it. `flex-wrap: nowrap` because the bar's job is
 * to be one band — when it wrapped, the primary button landed on a second line
 * below its own menu trigger.
 */
/*
 * The selection bar is a row, not a card.
 *
 * It used to carry a border, a fill and rounded corners, which made a mode
 * announcement read as a panel inserted into the page — and the launch face's
 * pick bar never had that dressing, although the two rows do the same job on two
 * faces. What separates it from the list is the count and the accent-coloured
 * launch button, not a box drawn around them. It is also the same 30px as the
 * search row it replaces, so the grid does not move when the mode turns on.
 */
.select-bar {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0;
  flex: 0 0 auto;
  min-width: 0;
}

/* The count is the bar's statement, so it reads at the row's own weight rather
   than as a caption. */
.sel-count {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
}

/* "Select all" is a quiet text action, not a second button competing with the
   launch at the other end. */
.select-bar .sel-all {
  height: 24px;
  padding: 0 7px;
  font-size: 11px;
  color: var(--muted);
  background: transparent;
}

.select-bar .sel-all:hover {
  background: color-mix(in srgb, var(--text) 8%, transparent);
  color: var(--text);
}

/* Pushes the actions to the right end, so the bar has two groups rather than
   five evenly spaced controls. */
.sel-spacer {
  flex: 1 1 auto;
  min-width: 0;
}

.sel-more {
  display: inline-flex;
}

/*
 * The overflow menu. Rows carry their own icon and label, matching the create
 * menu — the two are the same kind of surface and should not look like two
 * different components.
 */
.select-menu {
  position: fixed;
  pointer-events: auto;
  z-index: 90;
  min-width: 168px;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-menu);
  animation: create-panel-in var(--motion-base) var(--ease-out);
  transform-origin: top left;
}

.select-menu .row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: 11.5px;
  text-align: left;
}

.select-menu .row:hover:not(:disabled) {
  background: var(--surface-2);
  color: var(--text);
}

.select-menu .row:disabled {
  opacity: 0.45;
}

.select-menu .row-icon {
  flex: 0 0 auto;
  color: var(--faint);
}

.search:focus-within {
  border-color: color-mix(in srgb, var(--line) 60%, var(--accent));
}

.search input {
  border: 0;
  outline: 0;
  background: transparent;
  width: 100%;
  font-size: 11px;
  color: var(--text);
}

.cards {
  /* One template for the rows and the per-group table header: a column stays a
     column across rows. The flexible tracks are `fr` rather than `auto`, so one
     long role label cannot widen the role column of only its own row. */
  /* The actions column held five controls, three of them text links, which is why
     it needed 190px. They are icon buttons now, so the column only has to fit
     the icon targets and their gaps — the width freed up goes to the columns a
     reader actually scans. */
  --id-cols: minmax(0, 1.15fr) minmax(0, 1.1fr) 58px 146px;
  display: flex;
  flex-direction: column;
  /* Grow to the body's height so a short list still starts at the top and the
     empty state (below) has a full-height box to centre itself in. */
  flex: 1 1 auto;
  /* Rows are joined into one block, so no gap: the header is the top cap and each
     row keeps only its side and bottom rules. Groups still need air between them,
     which the group header carries. */
  gap: 0;
  min-width: 0;
  padding: 1px 2px 2px 1px;
}

/*
 * Groups are separated by air, not by a rule.
 *
 * The wrapper is what the drag handlers and the insertion line attach to, so the
 * spacing rules moved onto it. They used to name `.cards > .group-head`, which
 * stopped matching the moment a wrapper was introduced — and the symptom was
 * exactly what the rule had been added to prevent: the group's own bottom rule
 * sat a few pixels above the table's cap and the two read as one doubled line
 * glued to the content under it.
 *
 * The heading draws no rule at all now. Three gaps do the work, and their
 * difference is the hierarchy: 22px above a heading (a new site starts), 6px
 * under it (the table belongs to it), and nothing under a table's foot (the next
 * heading's own gap separates them). Without that difference a table's foot and
 * the next heading were equidistant from everything, which is what made the
 * groups read as one long list.
 */
.cards > .site-head-wrap {
  /* 28px above a heading vs 6px under it: the ratio is what says "a new site
     starts here" instead of "the table continues with a label". At 22 the two
     gaps were close enough that a table's foot and the next heading read as one
     run. */
  margin-top: 28px;
}

/*
 * Collapsed groups sit closer together.
 *
 * The 28px above is spacing between a heading and *the table it owns* — it has
 * to be big enough to say "a new section starts". With every group folded there
 * are no tables, only headings, and the same gap turns a table of contents into
 * a column of lines scattered down the page. A folded group is one 24px row, so
 * the gap between two of them only has to separate them.
 */
.cards > .site-head-wrap.collapsed {
  margin-top: 10px;
}

.cards > .site-head-wrap.collapsed:first-child {
  margin-top: 0;
}

.cards > .site-head-wrap:first-child {
  margin-top: 0;
}

.cards > .site-head-wrap :deep(.group-head) {
  border-bottom: 0;
  padding-bottom: 6px;
}

.id-table-head {
  display: grid;
  grid-template-columns: var(--id-cols);
  align-items: center;
  gap: 10px;
  padding: 6px 10px 6px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  background: var(--bg-elevated);
  color: var(--faint);
  font-size: 10px;
  letter-spacing: 0.04em;
}

.id-table-head.picking {
  grid-template-columns: 16px var(--id-cols);
}

.table-head-actions {
  justify-self: end;
}

.group-url {
  font-size: var(--fs-2xs);
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.group-icon {
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  border-radius: 4px;
  border: 1px solid var(--line-soft);
  color: var(--faint);
}

.group-icon:hover {
  color: var(--text);
  border-color: var(--line);
}

/* ------------------------------------------------------------------ */
/* The use face                                                        */
/* ------------------------------------------------------------------ */

/*
 * A tile is a launch target, not a row of data.
 *
 * The page is a floating pane, never a full window, so "how much fits" is decided
 * by about 700px of width: three tiles per row, each about 30px shorter than the
 * table row it replaces, and no column rules. What the tile drops (password mode,
 * browser, extra fields) is exactly what the edit face is for.
 */
.mode-switch {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
  background: var(--bg-elevated);
}

.mode {
  display: grid;
  place-items: center;
  width: 24px;
  height: 22px;
  border-radius: var(--radius-sm);
  color: var(--faint);
}

.mode:hover {
  color: var(--text-secondary);
}

.mode.on {
  background: var(--surface-3);
  color: var(--text);
}

/*
 * Master and detail, side by side.
 *
 * The left column is a list of places a page can start; the right column is what
 * one of them contains. This is what keeps the pane narrow and the list short:
 * a site costs one row in the left column however many accounts it has, so adding
 * the twentieth site adds a row instead of pushing everything down.
 *
 * Both columns scroll independently. The left one grows with the workspace's site
 * count (unbounded), the right one with one site's account count (small), and a
 * single shared scroller would tie the two together — scrolling a long site would
 * move the list out of view while the reader is still choosing.
 */
.split-face {
  display: grid;
  grid-template-columns: 148px minmax(0, 1fr);
  margin-top: 14px;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.split-nav {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-height: 0;
  overflow-y: auto;
  padding-right: 8px;
  border-right: 1px solid var(--line-soft);
}

/*
 * The search field, at the top of the left column.
 *
 * Full width of the column and shaped like a field, not like a toolbar control:
 * it filters the list underneath it, and the field's own width is the claim
 * "type here to narrow what is below".
 */
.nav-search {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 7px;
  margin-bottom: 8px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--text) 4%, transparent);
  color: var(--faint);
  flex: 0 0 auto;
}

.nav-search:focus-within {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--line-soft));
}

.nav-search input {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  background: none;
  color: var(--text);
  font-size: var(--fs-2xs);
  outline: none;
}

.nav-search input::placeholder {
  color: var(--faint);
}

.nav-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding: 2px 6px 4px;
  font-size: 10px;
  letter-spacing: 0.04em;
  color: var(--faint);
  flex: 0 0 auto;
}

.nav-head-sites {
  margin-top: 10px;
}

.nav-add {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: var(--radius-sm);
  color: var(--faint);
}

.nav-add:hover {
  background: color-mix(in srgb, var(--text) 8%, transparent);
  color: var(--text);
}

/* One row per place. The left column is a table of contents, so its rows are
   text with a count — a tile in the narrow column would be a card with nothing
   in it. */
.nav-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: var(--fs-sm);
  text-align: left;
  flex: 0 0 auto;
}

.nav-row:hover {
  background: color-mix(in srgb, var(--text) 7%, transparent);
  color: var(--text);
}

.nav-row.active {
  background: var(--surface-3);
  color: var(--text);
}

/* The default session is marked on its icon, not by a filled row: the row is a
   place you open, and a filled row reads as "you are here". */
.nav-row.current .nav-icon {
  color: var(--accent);
}

.nav-row.dashed {
  border: 1px dashed var(--line-soft);
  color: var(--muted);
}

.nav-icon {
  flex: 0 0 auto;
  color: var(--faint);
}

.nav-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nav-count {
  flex: 0 0 auto;
  font-size: 10px;
  color: var(--faint);
}

/*
 * A global identity's row: name, an optional 「默认」 badge, and its writes.
 *
 * The actions stay hidden until the row is hovered or focused. They are the
 * low-frequency half of the row — an identity is clicked to open it far more
 * often than it is renamed — and three resting icons in a 200px column would
 * leave the name four characters.
 */
.identity-row {
  position: relative;
}

.identity-badge {
  flex: 0 0 auto;
  padding: 0 4px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent-text);
  font-size: var(--fs-2xs);
  line-height: 15px;
}

.identity-actions {
  display: flex;
  align-items: center;
  gap: 1px;
  flex: 0 0 auto;
  opacity: 0;
}

.identity-row:hover .identity-actions,
.identity-row:focus-within .identity-actions {
  opacity: 1;
}

.row-action {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 3px;
  color: var(--faint);
}

.row-action:hover {
  background: color-mix(in srgb, var(--text) 9%, transparent);
  color: var(--text);
}

.row-action.danger:hover {
  background: color-mix(in srgb, var(--red) 16%, transparent);
  color: var(--red);
}

.nav-empty {
  margin: 0;
  padding: 4px 6px;
  font-size: var(--fs-2xs);
  color: var(--faint);
}

.split-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  min-height: 0;
  padding-left: 12px;
  padding-top: 2px;
}

/*
 * The only scroller in the right column.
 *
 * The control row above is a sibling, so a long account list never carries
 * "启动所选" out of the pane: the bar is the one control the pick mode exists for.
 */
.split-scroll {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding-bottom: 4px;
}

/* The selected site's own header. Its name and address are the context for
   everything below, and its write actions live here rather than in the left
   column: the left column only navigates. */
/* The same height as the pick bar it is swapped for: this row and the bar share
   one slot, and any difference shows up as the tiles jumping when the mode
   turns on. */
.detail-head {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  min-width: 0;
  flex: 0 0 auto;
}

.detail-name {
  font-size: var(--fs-base);
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-url {
  font-size: var(--fs-2xs);
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.detail-empty {
  margin: 0;
  padding: 10px 2px;
  font-size: var(--fs-sm);
  color: var(--faint);
}


/*
 * The pick bar, in the right column's control slot.
 *
 * It is not an extra band above the grid: the bar replaces the search row, so
 * turning the mode on moves nothing below it.
 */
.pick-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  /* Height, not min-height, and the same 30px as the search row it replaces. */
  height: 30px;
}

.pick-bar .sel-count {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
}

/* Same quiet text action as the edit face's "select all". */
.pick-bar .pick-all {
  height: 24px;
  padding: 0 7px;
  border-radius: var(--radius-sm);
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
}

.pick-bar .pick-all:hover {
  background: color-mix(in srgb, var(--text) 8%, transparent);
  color: var(--text);
}

.tiles {
  display: grid;
  /* A consistent column width across groups, rather than stretching two tiles to
     fill a row that could hold three. `auto-fill` keeps the empty track, so a
     site with two accounts puts them at the same size as a site with five —
     stretching is what makes a two-account group look like a different widget
     from a five-account one. */
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px;
}

.tile {
  position: relative;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 10px;
  min-width: 0;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
  background: var(--surface);
  text-align: left;
  transition:
    border-color var(--motion-fast) var(--ease-out),
    background var(--motion-fast) var(--ease-out);
}

/* Picking turns the tile's verb from "open" into "pick", so the hover border
   stops promising a launch. */
.tile.picking:hover {
  border-color: var(--line);
}

.tile.picked {
  border-color: color-mix(in srgb, var(--accent) 62%, var(--line));
  background: color-mix(in srgb, var(--accent) 9%, var(--surface));
}

/*
 * The pick checkbox: a circle in the tile's top-left corner, over the avatar.
 *
 * Absolute rather than a flex child — a fourth column would widen every tile and
 * narrow the name beside it, and the name is what the user is reading when they
 * decide which accounts to pick. It also has to stay in place whether or not it
 * is ticked, or the row would shuffle when the first selection is made.
 */
.tile-pick {
  position: absolute;
  left: 5px;
  top: 5px;
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1.5px solid var(--line);
  background: var(--surface);
  color: var(--action-foreground);
  pointer-events: none;
}

.tile.picked .tile-pick {
  border-color: var(--accent);
  background: var(--accent);
}

/* A picked tile dims its avatar slightly: the checkbox carries the state, and a
   second full-strength colour on top would read as a different kind of tile. */
.tile.picked .tile-avatar {
  opacity: 0.55;
}

.tile:hover {
  border-color: color-mix(in srgb, var(--role) 55%, var(--line));
  background: var(--bg-elevated);
}

.tile-avatar {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  flex: 0 0 26px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--role) 18%, transparent);
  color: color-mix(in srgb, var(--role) 78%, var(--text));
  font-size: 12px;
}

.tile-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1 1 auto;
}

.tile-name {
  font-size: 12px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tile-role {
  font-size: var(--fs-2xs);
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tile-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 6px;
  border-radius: 50%;
  background: var(--line);
}

.tile-dot.live {
  background: var(--green);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--green) 18%, transparent);
}

.tile-dot.expired {
  background: var(--red);
}

/* ------------------------------------------------------------------ */
/* Site reordering (edit face)                                         */
/* ------------------------------------------------------------------ */

.id-card {
  --role: var(--role-slate);
  position: relative;
  text-align: left;
  /* A `div` with a button role: the native button's own chrome has to be
     neutralised by hand now that a real launch control lives inside it. */
  cursor: pointer;
  font: inherit;
  color: inherit;
  /* Same reasoning as the sites row: the page and the row share a surface, so
     the edge has to be the stronger hairline or the row disappears into the
     background in the light theme. */
  display: grid;
  grid-template-columns: var(--id-cols);
  align-items: center;
  gap: 10px;
  min-width: 0;
  min-height: 46px;
  padding: 7px 10px 7px 12px;
  border: 1px solid var(--line);
  /* Joined rows: the header is the cap, the last row is the foot, and every row
     between keeps only its side and bottom rules. */
  border-top: 0;
  border-radius: 0;
  /* One flat surface. A border and the identity's own left rule are enough to
     separate a row from the page. */
  background: var(--surface);
  overflow: hidden;
  transition: border-color var(--motion-base) var(--ease-out), background var(--motion-base) var(--ease-out);
}

/* The table's foot: the last row of a group's block. Every row is a sibling of
   the group's header (the `template v-for` adds no wrapper), so "last in this
   group" is not something `nth-*` can express across groups — the class says it. */
.id-card.last {
  border-radius: 0 0 var(--radius-lg) var(--radius-lg);
}

.id-card.picking {
  grid-template-columns: 16px var(--id-cols);
  cursor: pointer;
}

.view-table .id-card {
  border-radius: 0;
  border-top: 0;
}

.id-card::before {
  content: "";
  position: absolute;
  inset: 0 auto 0 0;
  width: 2px;
  background: var(--role);
  opacity: 0.9;
}

/* No lift on hover: a row that rises under the cursor makes a list feel like a
   stack of loose tiles. The border taking the identity colour is the response. */
.id-card:hover {
  border-color: color-mix(in srgb, var(--role) 34%, var(--line));
}

.id-card.running {
  border-color: color-mix(in srgb, var(--role) 46%, var(--line));
  background: var(--surface-2);
}

.id-card.picked {
  border-color: color-mix(in srgb, var(--accent) 62%, var(--line));
  background: color-mix(in srgb, var(--accent) 8%, var(--surface));
}

/* A checkbox in the leading cell, sized like the rows' own tags so it reads as
   part of the row rather than an overlay widget. */
.pick-mark {
  width: 15px;
  height: 15px;
  border-radius: 4px;
  border: 1px solid var(--line);
  background: var(--bg-elevated);
  display: grid;
  place-items: center;
  color: var(--action-foreground);
}

.pick-mark.on {
  border-color: transparent;
  background: var(--action);
}

.card-pick-note {
  font-size: 10.5px;
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.avatar {
  /* 32px from the mockup, not 24. At 24 the initial was smaller than the card's
     own name text and the card read as a list row; the mockup's card is built
     around a square avatar as the anchor, with the name and address beside it. */
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  border-radius: var(--radius-lg);
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--role) 15%, var(--surface));
  color: color-mix(in srgb, var(--role) 82%, var(--text));
  font-size: var(--fs-base);
  font-weight: 500;
}

/* Name over account, not beside it. The account cell in a row is narrow enough
   that side-by-side name and address would each truncate to a few characters;
   stacked, both usually fit and the row height still has room for the avatar. */
.who {
  min-width: 0;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.name {
  font-size: var(--fs-base);
  font-weight: 500;
  letter-spacing: 0.005em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.acct {
  font-size: var(--fs-2xs);
  line-height: 1.35;
  color: var(--faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  overflow: hidden;
  font-size: 10.5px;
  color: var(--faint);
  white-space: nowrap;
  flex: 0 0 auto;
}

.state .dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--role) 45%, var(--faint));
}

.state.live {
  color: var(--green);
}

.state.live .dot {
  background: var(--green);
  box-shadow: 0 0 7px color-mix(in srgb, var(--green) 70%, transparent);
}

.state.warn {
  color: var(--accent-text);
}

.state.warn .dot {
  background: var(--accent);
}

/*
 * Facts stay on ONE line, and the row stays the same height whatever an account
 * carries.
 *
 * The row used to wrap. That looked harmless while every seed account had the
 * same three chips, but a real workspace has accounts with a long role label, a
 * custom engine and several extra fields — those rows grew a second chip line,
 * the whole table row stretched to match, and every neighbouring row got a band
 * of empty space under its actions. One aligned line of chips is what makes a
 * list of accounts comparable at a glance, which is the only reason this page
 * exists.
 *
 * So the row holds exactly what always fits: the role (given its natural width,
 * it is the fact people scan for) and the password state. Anything else becomes
 * a "+N" chip (see `extraFacts`).
 */
.meta-row {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: nowrap;
  overflow: hidden;
  min-height: 18px;
}

.tag {
  font-size: 10px;
  letter-spacing: 0.03em;
  border: 1px solid color-mix(in srgb, var(--role) 30%, var(--line));
  border-radius: 3px;
  padding: 2px 5px;
  color: color-mix(in srgb, var(--role) 72%, var(--text-secondary));
  background: color-mix(in srgb, var(--role) 7%, transparent);
  white-space: nowrap;
  min-width: 0;
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* The role must not be cut: "数据管理员 · 读写" truncated to "数据管理…" is the
   same as no label at all. But letting it take 62% left the password chip with
   whatever was left, which is how every row in a narrow pane read
   "member 未设…". It may push, not dominate: the cap is half the column, and the
   password chip shares the rest. */
.meta-row > .tag-role {
  flex: 0 1 auto;
  max-width: 50%;
}

.meta-row > .tag.plain {
  flex: 0 1 auto;
  min-width: 0;
}

/* The counter never shrinks: a half-drawn "+" is worse than a missing chip. */
.meta-row > .tag.more {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}

.tag.plain {
  color: var(--faint);
  border-color: var(--line-soft);
  background: transparent;
}

/* "No password" is the one fact on this line that needs attention, so it is the
   one that gets a colour. Everything else is neutral by design. */
.tag.plain.missing {
  color: color-mix(in srgb, var(--accent) 82%, var(--text));
  border-color: color-mix(in srgb, var(--accent) 34%, var(--line-soft));
}

/*
 * Always visible, in the last column of the row.
 *
 * Folding this cell until hover was a mistake: the row changed height whenever
 * the pointer crossed it, so the list reflowed as the mouse moved. A stable row
 * is worth more than the ~18px it saves.
 *
 * The cell does not wrap, for the same reason the facts cell does not: one
 * account with an extra action ("stop" instead of "switch") must not make its
 * row one line taller than the rest. Session actions sit left, management
 * actions are pinned to the right edge as icon buttons.
 */
.card-actions {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  justify-content: flex-end;
  /* The wider space is between the two groups, not between neighbours inside
     one: session actions are things you do to a running page, the pencil edits
     the account. A uniform gap made the cluster read as five equal verbs. */
  gap: 10px;
  min-width: 0;
  overflow: hidden;
  font-size: 11px;
  color: var(--muted);
}

.card-session {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  /* Not `flex: 1 1 auto`. That let the session group absorb every spare pixel of
     the actions column, so its actions sat at the left edge of a wide gap while
     the edit icon sat alone at the right edge — the row read as "three links …
     a distant pencil". The column is right-aligned; this group should only be as
     wide as what it holds. */
  flex: 0 0 auto;
  overflow: hidden;
}

.card-manage {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
}

/* Dialog footer layout. Scoped styles do not reach Modal's own slots, so the
   spacer has to be defined here rather than reused from another component. */
.spacer {
  flex: 1;
}

.link-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.link-field .label {
  font-size: 10.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--faint);
}

/* The export dialog's two bits of furniture. Its body is one labelled field, so
   it borrows the link dialog's caption treatment rather than a second style. */
.field .label {
  font-size: 10.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--faint);
}

.error {
  margin: 0;
  font-size: 11px;
  color: var(--red);
}

/* The frame comes from the shared `.empty` rule; only the placement is this
   page's own. The response is normally a grid, but the shared `.empty` centres
   itself with `margin: auto`, which does nothing inside a grid whose rows are
   content-height — so when the grid holds nothing but the placeholder, it
   becomes a one-item flex column and the shared centring works as written.
   The width override stays: the shared cap is a measure for prose, and without
   it the box shrank to a 264px column and the button label wrapped. */
.cards:has(> .empty) {
  display: flex;
  flex-direction: column;
}

.empty {
  justify-self: center;
}

@media (max-width: 820px) {
  .cards {
    --id-cols: minmax(0, 1.1fr) minmax(0, 0.8fr) 78px minmax(150px, 1.4fr);
  }
}

@media (max-width: 900px) {
  .identities {
    padding: 14px;
  }

  .search {
    width: 150px;
  }
}
</style>
