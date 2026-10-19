<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Trash2 } from "lucide-vue-next";
import Modal from "./Modal.vue";
import LayoutPreview from "./LayoutPreview.vue";
import { useWorkspaceStore } from "../stores/workspace";
import type { Identity, LayoutPreset, SceneDraft } from "@shared/types";

const props = defineProps<{
  draft: SceneDraft;
  identities: Identity[];
  presets: LayoutPreset[];
}>();

const emit = defineEmits<{
  close: [];
  save: [draft: SceneDraft];
  delete: [];
}>();

const store = useWorkspaceStore();
const { t } = useI18n();
const form = reactive<SceneDraft>({
  ...props.draft,
  identityIds: [...props.draft.identityIds],
  slotAssignments: { ...props.draft.slotAssignments },
});
const error = reactive<{ message: string | null }>({ message: null });

watch(
  () => props.draft,
  (next) =>
    Object.assign(form, next, {
      identityIds: [...next.identityIds],
      slotAssignments: { ...next.slotAssignments },
    }),
);

const selectedPreset = computed<LayoutPreset>(() => store.presetById(form.layoutId));
const presetSlots = computed(() => selectedPreset.value.slots.length);

function toggle(id: string) {
  if (form.identityIds.includes(id)) {
    form.identityIds = form.identityIds.filter((item) => item !== id);
    delete form.slotAssignments[id];
  } else {
    form.identityIds = [...form.identityIds, id];
  }
}

/** Slot i is shown as occupied by the i-th selected member until reassigned. */
function slotOwner(index: number): Identity | undefined {
  const assignedId = Object.entries(form.slotAssignments).find(([, slot]) => slot === index)?.[0];
  if (assignedId) {
    return props.identities.find((identity) => identity.id === assignedId);
  }
  const free = form.identityIds.filter((id) => !(id in form.slotAssignments));
  const fallbackIndex =
    index - Object.values(form.slotAssignments).filter((slot) => slot < index).length;
  const identityId = free[Math.max(0, fallbackIndex)];
  return props.identities.find((identity) => identity.id === identityId);
}

function chooseLayout(layoutId: string) {
  form.layoutId = layoutId;
  // Assignments only make sense against the new slot list.
  form.slotAssignments = {};
}

function submit() {
  error.message = null;
  if (!form.name.trim()) {
    error.message = t("app.errSceneName");
    return;
  }
  if (form.identityIds.length === 0) {
    error.message = t("app.errSceneMember");
    return;
  }
  emit("save", {
    ...form,
    name: form.name.trim(),
    slotAssignments: { ...form.slotAssignments },
  });
}
</script>

<template>
  <Modal
    :open="true"
    :title="form.id ? $t('app.editSceneTitle') : $t('app.newSceneTitle')"
    :description="$t('app.sceneDialogDesc')"
    width="620px"
    @close="emit('close')"
  >
    <div class="form">
      <label class="field">
        <span class="label">{{ $t("app.sceneNameLabel") }}</span>
        <input v-model="form.name" class="input" :placeholder="$t('app.sceneNameExample')" />
      </label>

      <div class="field">
        <span class="label">{{ $t("app.sceneMembersLabel") }}</span>
        <div class="members">
          <button
            v-for="identity in identities"
            :key="identity.id"
            type="button"
            class="member"
            :class="{ on: form.identityIds.includes(identity.id) }"
            :style="{ '--role': `var(--role-${identity.color})` }"
            @click="toggle(identity.id)"
          >
            <span class="d">{{ identity.name.slice(0, 1) }}</span>
            <span class="m-copy">
              <span class="m-name">{{ identity.name }}</span>
              <span class="m-acct mono">{{ identity.role }}</span>
            </span>
            <span class="order mono" v-if="form.identityIds.includes(identity.id)">
              {{ form.identityIds.indexOf(identity.id) + 1 }}
            </span>
          </button>
        </div>
        <p v-if="!identities.length" class="note">{{ $t("app.sceneNoIdentities") }}</p>
      </div>

      <div class="field">
        <span class="label">{{ $t("app.windowLayout") }}</span>
        <div class="layouts">
          <button
            v-for="preset in presets"
            :key="preset.id"
            type="button"
            class="layout-btn"
            :class="{ on: form.layoutId === preset.id }"
            @click="chooseLayout(preset.id)"
          >
            {{ store.presetName(preset) }}
            <span v-if="!preset.builtin" class="custom-tag">{{ $t("app.customTag") }}</span>
          </button>
        </div>
        <LayoutPreview :preset="selectedPreset" height="118px">
          <template #slot="{ index }">
            <span
              v-if="slotOwner(index)"
              class="slot-owner"
              :style="{ '--role': `var(--role-${slotOwner(index)?.color})` }"
            >
              <span class="d">{{ slotOwner(index)?.name.slice(0, 1) }}</span>
              {{ slotOwner(index)?.name }}
            </span>
            <span v-else class="slot-empty">{{ $t("app.freeSlot", { index: index + 1 }) }}</span>
          </template>
        </LayoutPreview>
        <p class="note">{{ $t("app.sceneLayoutNote", { count: presetSlots }) }}</p>
      </div>

      <p class="note">{{ $t("app.sceneOrderNote") }}</p>
      <p v-if="error.message" class="error" role="alert">{{ error.message }}</p>
    </div>

    <template #footer>
      <button v-if="form.id" type="button" class="btn danger" @click="emit('delete')">
        <Trash2 :size="12" />
        {{ $t("app.delete") }}
      </button>
      <span class="spacer"></span>
      <button type="button" class="btn" @click="emit('close')">{{ $t("app.cancel") }}</button>
      <button type="button" class="btn primary" @click="submit">{{ $t("app.save") }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.label {
  font-size: 10.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--faint);
}

.input {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  padding: 7px 9px;
  font-size: 11.5px;
  color: var(--text);
  outline: 0;
}

.input:focus {
  border-color: color-mix(in srgb, var(--line) 55%, var(--accent));
}

.members {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  max-height: 190px;
  overflow-y: auto;
  padding: 1px;
}

.member {
  --role: var(--role-slate);
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
  background: var(--bg-elevated);
  padding: 7px 8px;
  text-align: left;
  min-width: 0;
}

.member:hover {
  border-color: var(--line);
}

.member.on {
  border-color: color-mix(in srgb, var(--role) 50%, var(--line));
  background: color-mix(in srgb, var(--role) 7%, var(--bg-elevated));
}

.member .d {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  flex: 0 0 22px;
  display: grid;
  place-items: center;
  background: var(--role);
  color: var(--accent-foreground);
  font-size: 10.5px;
  font-weight: 500;
}

.m-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.m-name {
  font-size: 11.5px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.m-acct {
  font-size: 10px;
  color: var(--faint);
}

.order {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--role);
  border: 1px solid color-mix(in srgb, var(--role) 40%, var(--line));
  border-radius: 999px;
  width: 16px;
  height: 16px;
  display: grid;
  place-items: center;
  flex: 0 0 16px;
}

.layouts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.layout-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--faint);
  font-size: 11px;
  padding: 5px 8px;
}

.layout-btn:hover {
  color: var(--text-secondary);
  border-color: var(--line);
}

.layout-btn.on {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-foreground);
  font-weight: 500;
}

.custom-tag {
  font-size: 9px;
  opacity: 0.7;
}

.slot-owner {
  --role: var(--role-slate);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-secondary);
  font-size: 10px;
  min-width: 0;
}

.slot-owner .d {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--role);
  color: var(--accent-foreground);
  display: grid;
  place-items: center;
  font-size: 8px;
  flex: 0 0 14px;
}

.slot-empty {
  color: var(--faint);
}

.note {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--faint);
}

.error {
  margin: 0;
  font-size: 11px;
  color: var(--red);
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: var(--radius);
  padding: 7px 12px;
  font-size: 11.5px;
  border: 1px solid var(--line);
  background: var(--surface-2);
  color: var(--text-secondary);
}

.btn:hover:not(:disabled) {
  background: var(--surface-3);
  border-color: color-mix(in srgb, var(--line) 70%, var(--accent));
}

.btn.primary {
  background: linear-gradient(180deg, var(--accent-strong), color-mix(in srgb, var(--accent) 88%, black));
  border-color: color-mix(in srgb, var(--accent) 80%, black);
  color: var(--accent-foreground);
  font-weight: 500;
}

.btn.primary:hover:not(:disabled) {
  background: linear-gradient(180deg, var(--accent-strong), color-mix(in srgb, var(--accent) 88%, black));
  border-color: color-mix(in srgb, var(--accent) 80%, black);
  color: var(--accent-foreground);
  filter: brightness(1.07);
}

.btn.danger {
  color: var(--red);
  border-color: color-mix(in srgb, var(--red) 34%, var(--line));
}

.spacer {
  flex: 1;
}
</style>
