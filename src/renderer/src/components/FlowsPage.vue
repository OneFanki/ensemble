<script setup lang="ts">
import type { Flow, FlowParam, FlowStep } from "@shared/flows";
import { FLOW_ACTIONS, FLOW_KEYS, summarizeStep } from "@shared/flows";
import type { Identity, Site } from "@shared/types";
import {
  ArrowRight,
  GripVertical,
  ListChecks,
  Pencil,
  Play,
  Plus,
  Trash2,
  X,
} from "lucide-vue-next";
import { computed, ref, watchEffect } from "vue";
import { useI18n } from "vue-i18n";
import { useGroupCollapse } from "../composables/useGroupCollapse";
import { useConfirmStore } from "../stores/confirm";
import { useNavigationStore } from "../stores/navigation";
import { useWorkspaceStore } from "../stores/workspace";
import GroupCollapseAll from "./GroupCollapseAll.vue";
import Modal from "./Modal.vue";
import SelectField from "./SelectField.vue";
import AppButton from "./ui/AppButton.vue";
import Checkbox from "./ui/Checkbox.vue";
import EmptyState from "./ui/EmptyState.vue";
import FormField from "./ui/FormField.vue";
import GroupHeader from "./ui/GroupHeader.vue";
import IconButton from "./ui/IconButton.vue";
import LinkButton from "./ui/LinkButton.vue";
import PageHeader from "./ui/PageHeader.vue";
import SplitPane from "./ui/SplitPane.vue";
import TextField from "./ui/TextField.vue";

/**
 * Flows: the fourth kind of asset, next to sites, accounts and views.
 *
 * A site says where to go and how to sign in. An account says who. A view says
 * what to look at together. A flow says what to do — the sequence an AI worked
 * out on this particular admin console, kept so it does not have to be worked
 * out again. It belongs to a site because the steps reference that site's DOM and
 * mean nothing anywhere else.
 *
 * Everything here is plain data, which is what lets the same definition run from
 * the UI and from `run_flow` over MCP.
 */
const store = useWorkspaceStore();
const confirm = useConfirmStore();
const navigation = useNavigationStore();
const { t } = useI18n();

const selectedId = ref("");
const editing = ref<Flow | "new" | null>(null);
const running = ref<Flow | null>(null);
const runParams = ref<Record<string, string>>({});
const runIdentityId = ref<string>("");
const runResult = ref<{ ok: boolean; index?: number; reason?: string; steps: number } | null>(null);
const runError = ref("");

const flows = computed(() => store.flows);

/** Grouped by site: a flow is useless without knowing which console it drives. */
const groups = computed(() => {
  const bySite = new Map<string, Flow[]>();
  for (const flow of flows.value) {
    const list = bySite.get(flow.siteId) ?? [];
    list.push(flow);
    bySite.set(flow.siteId, list);
  }
  return [...bySite.entries()].map(([siteId, items]) => ({
    siteId,
    name: store.sites.find((site) => site.id === siteId)?.name ?? "—",
    flows: items,
  }));
});

const groupCollapse = useGroupCollapse("ensemble.groups.flows");
const groupKeys = computed(() => groups.value.map((group) => group.siteId));
const allCollapsed = computed(() => groupCollapse.allCollapsed(groupKeys.value));

const selected = computed<Flow | undefined>(
  () => flows.value.find((flow) => flow.id === selectedId.value) ?? flows.value[0],
);

watchEffect(() => {
  const current = selected.value;
  if (current && current.id !== selectedId.value) selectedId.value = current.id;
});

const selectedSite = computed<Site | undefined>(() =>
  store.sites.find((site) => site.id === selected.value?.siteId),
);

/** Accounts of the flow's site; the run dialog offers them, first one by default. */
const runnableIdentities = computed<Identity[]>(() =>
  selected.value
    ? store.identities.filter((identity) => identity.siteId === selected.value?.siteId)
    : [],
);

function flowSiteName(flow: Flow): string {
  return store.sites.find((site) => site.id === flow.siteId)?.name ?? "—";
}

function stepSummary(step: FlowStep) {
  return summarizeStep(step);
}

function actionLabel(action: FlowStep["action"]): string {
  const key = `app.action${action.charAt(0).toUpperCase()}${action.slice(1)}`;
  return t(key);
}

function openRun(flow: Flow) {
  running.value = flow;
  runResult.value = null;
  runError.value = "";
  const values: Record<string, string> = {};
  for (const param of flow.params) values[param.name] = param.default ?? "";
  runParams.value = values;
  const first = store.identities.find((identity) => identity.siteId === flow.siteId);
  runIdentityId.value = first?.id ?? "";
}

async function confirmRun() {
  const flow = running.value;
  if (!flow) return;
  runError.value = "";
  const outcome = await store.runFlow({
    flowId: flow.id,
    ...(runIdentityId.value ? { identityId: runIdentityId.value } : {}),
    params: runParams.value,
  });
  if (!outcome) {
    runError.value = t("app.toastRequestFailed");
    return;
  }
  runResult.value = {
    ok: outcome.run.ok,
    ...(outcome.run.failedAt !== undefined ? { index: outcome.run.failedAt + 1 } : {}),
    ...(outcome.run.reason ? { reason: outcome.run.reason } : {}),
    steps: outcome.run.steps.length,
  };
  if (outcome.run.ok) {
    store.notify(t("app.flowRunDone", { count: outcome.run.steps.length }), "success");
  } else {
    store.notify(t("app.flowRunFailedShort", { index: (outcome.run.failedAt ?? 0) + 1 }), "error");
  }
}

async function removeFlow(flow: Flow) {
  const accepted = await confirm.ask({
    title: t("app.delete"),
    body: t("app.flowDeleteConfirm", { name: flow.name }),
    confirmLabel: t("app.delete"),
    tone: "danger",
  });
  if (!accepted) return;
  await store.deleteFlow(flow.id);
}

/* ---------------------------------------------------------------- editor -- */

const draft = ref<{
  id?: string;
  siteId: string;
  name: string;
  description: string;
  params: FlowParam[];
  steps: FlowStep[];
}>({ siteId: "", name: "", description: "", params: [], steps: [] });
const editorError = ref("");

const siteOptions = computed(() =>
  store.sites.map((site) => ({ value: site.id, label: site.name, hint: site.baseUrl })),
);

function openEditor(flow?: Flow) {
  editorError.value = "";
  if (flow) {
    draft.value = {
      id: flow.id,
      siteId: flow.siteId,
      name: flow.name,
      description: flow.description,
      params: flow.params.map((param) => ({ ...param })),
      steps: flow.steps.map((step) => ({ ...step })),
    };
  } else {
    draft.value = {
      siteId: store.sites[0]?.id ?? "",
      name: "",
      description: "",
      params: [],
      steps: [{ action: "navigate", url: "/" }],
    };
  }
  editing.value = flow ?? "new";
}

function addParam() {
  draft.value.params.push({ name: "", label: "" });
}

function addStep() {
  draft.value.steps.push({ action: "fill", label: "", value: "" });
}

function removeStep(index: number) {
  draft.value.steps.splice(index, 1);
}

function moveStep(index: number, delta: number) {
  const next = index + delta;
  const steps = draft.value.steps;
  if (next < 0 || next >= steps.length) return;
  const [item] = steps.splice(index, 1);
  if (item) steps.splice(next, 0, item);
}

/*
 * Step rows also drag, from the grip only: a row is mostly inputs, and a
 * draggable row would fight text selection. The arrow buttons stay — they are
 * the keyboard path to the same result.
 */
const draggedStepIndex = ref<number | null>(null);
const dropStepIndex = ref<number | null>(null);

function onStepDragStart(index: number, event: DragEvent): void {
  draggedStepIndex.value = index;
  event.dataTransfer?.setData("text/plain", String(index));
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}

function onStepDragOver(index: number, event: DragEvent): void {
  if (draggedStepIndex.value === null || draggedStepIndex.value === index) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  dropStepIndex.value = index;
}

function onStepDragLeave(index: number): void {
  if (dropStepIndex.value === index) dropStepIndex.value = null;
}

function onStepDrop(index: number): void {
  const from = draggedStepIndex.value;
  onStepDragEnd();
  if (from === null || from === index) return;
  const steps = draft.value.steps;
  const [item] = steps.splice(from, 1);
  if (item) steps.splice(index, 0, item);
}

function onStepDragEnd(): void {
  draggedStepIndex.value = null;
  dropStepIndex.value = null;
}

/** Fields a step shows depend on its action; anything irrelevant would confuse. */
function needsTarget(step: FlowStep): boolean {
  return ["fill", "click", "select", "read", "wait"].includes(step.action);
}

async function saveDraft() {
  editorError.value = "";
  const saved = await store.saveFlow({
    ...(draft.value.id ? { id: draft.value.id } : {}),
    siteId: draft.value.siteId,
    name: draft.value.name,
    description: draft.value.description,
    params: draft.value.params,
    steps: draft.value.steps,
  });
  if (saved === undefined) return;
  editing.value = null;
}
</script>

<template>
  <section class="page flows">
    <PageHeader :title="$t('app.flows')">
      <template #actions>
        <GroupCollapseAll
          v-if="groups.length > 1"
          :all-collapsed="allCollapsed"
          @toggle="groupCollapse.toggleAll(groupKeys)"
        />
        <!-- The empty state below carries this action, next to the sentence that
             explains it. One page with the same button in both places asks the
             user which one is the real one. -->
        <AppButton v-if="flows.length" variant="primary" :disabled="!store.sites.length"
          :title="store.sites.length ? '' : $t('app.flowNoSite')"
          @click="openEditor()">
          <Plus :size="13" />
          {{ $t("app.newFlow") }}
        </AppButton>
      </template>
    </PageHeader>

    <!--
      With no site, "new flow" cannot be the suggestion: a flow has to belong to
      one, so the button would only ever be inert. The empty state points at the
      thing that is actually missing instead, which is also why it is the only
      place the action appears while there is nothing to list.
    -->
    <EmptyState
      v-if="!flows.length"
      :text="store.sites.length ? $t('app.flowsEmpty') : $t('app.flowsEmptyNoSite')"
    >
      <template #icon><ListChecks :size="22" /></template>
      <AppButton
        v-if="store.sites.length"
        variant="primary"
        @click="openEditor()">
        <Plus :size="13" />
        {{ $t("app.newFlow") }}
      </AppButton>
      <AppButton v-else variant="primary" @click="navigation.navigate('sites')">
        {{ $t("app.flowGoToSites") }}
      </AppButton>
    </EmptyState>

    <SplitPane v-else dense>
      <template #list>
        <div class="flow-list" role="listbox" :aria-label="$t('app.flows')">
        <template v-for="group in groups" :key="group.siteId">
          <GroupHeader
            :name="group.name"
            :count="group.flows.length"
            :collapsed="groupCollapse.isCollapsed(group.siteId)"
            @toggle="groupCollapse.toggle(group.siteId)"
          />
          <button
            v-for="flow in groupCollapse.isCollapsed(group.siteId) ? [] : group.flows"
            :key="flow.id"
            type="button"
            role="option"
            class="flow-row"
            :class="{ selected: flow.id === selected?.id }"
            :aria-selected="flow.id === selected?.id"
            @click="selectedId = flow.id"
          >
            <span class="flow-copy">
              <span class="flow-name">{{ flow.name }}</span>
              <span class="flow-sub mono">
                {{ $t("app.flowStepsCount", { count: flow.steps.length }) }}
                <template v-if="flow.params.length">
                  · {{ $t("app.flowParamsCount", { count: flow.params.length }) }}
                </template>
              </span>
            </span>
          </button>
        </template>
        </div>
      </template>

      <template #detail>
        <div v-if="selected" class="detail">
        <div class="detail-head">
          <div class="detail-copy">
            <h2>{{ selected.name }}</h2>
            <p class="detail-sub">
              {{ flowSiteName(selected) }} ·
              {{ $t("app.flowStepsCount", { count: selected.steps.length }) }}
            </p>
            <p v-if="selected.description" class="detail-desc">{{ selected.description }}</p>
          </div>
          <div class="detail-actions">
            <AppButton size="sm" :disabled="store.busy === 'flow' || !runnableIdentities.length"
              @click="openRun(selected)">
              <Play :size="11" />
              {{ $t("app.flowRun") }}
            </AppButton>
            <IconButton :ariaLabel="$t('app.edit')"
              @click="openEditor(selected)">
              <Pencil :size="12" />
            </IconButton>
            <IconButton variant="danger" :ariaLabel="$t('app.delete')"
              @click="removeFlow(selected)">
              <Trash2 :size="12" />
            </IconButton>
          </div>
        </div>

        <div v-if="selected.params.length" class="block">
          <p class="block-title">{{ $t("app.flowParams") }}</p>
          <div class="param-list">
            <span
              v-for="param in selected.params"
              :key="param.name"
              class="param-chip"
              :class="{ secret: param.secret }"
            >
              <span class="param-name mono">{{ param.name }}</span>
              <span class="param-label">{{ param.label }}</span>
              <span v-if="param.required" class="param-flag">{{ $t("app.flowParamRequiredShort") }}</span>
            </span>
          </div>
        </div>

        <div class="block">
          <p class="block-title">{{ $t("app.flowSteps") }}</p>
          <ol class="steps">
            <li v-for="(step, index) in selected.steps" :key="index" class="step">
              <span class="step-index mono">{{ index + 1 }}</span>
              <span class="step-action">{{ actionLabel(step.action) }}</span>
              <span class="step-target mono">{{ stepSummary(step).target }}</span>
              <span v-if="stepSummary(step).detail" class="step-detail">
                {{ stepSummary(step).detail }}
              </span>
            </li>
          </ol>
        </div>
        </div>
      </template>
    </SplitPane>

    <!-- Run: parameters first, because a flow is a template rather than a macro
         with hard-coded values. -->
    <Modal
      v-if="running"
      :open="true"
      :title="$t('app.flowRunTitle')"
      :description="running.name"
      width="520px"
      @close="running = null"
    >
      <div class="run-form">
        <FormField v-if="runnableIdentities.length > 1" :label="$t('app.flowRunIdentity')">
          <SelectField
            :model-value="runIdentityId || undefined"
            :options="runnableIdentities.map((i) => ({ value: i.id, label: i.name, hint: i.username }))"
            :aria-label="$t('app.flowRunIdentity')"
            @update:model-value="runIdentityId = $event ?? ''"
          />
        </FormField>
        <p v-else-if="runnableIdentities.length === 1" class="run-note">
          {{ $t("app.flowRunIdentity") }}：{{ runnableIdentities[0]?.name }}
        </p>
        <p v-else class="run-note">{{ $t("app.flowNoSite") }}</p>

        <p v-if="!running.params.length" class="run-note">{{ $t("app.flowRunNoParams") }}</p>
        <FormField v-for="param in running.params" :key="param.name">
          <template #label>
            {{ param.label }}
            <span class="field-var mono">{{ param.name }}</span>
            <span v-if="param.required" class="param-flag">{{ $t("app.flowParamRequiredShort") }}</span>
          </template>
          <TextField
            v-model="runParams[param.name]"
            :type="param.secret ? 'password' : 'text'"
            :placeholder="param.default ?? ''"
            autocomplete="off"
          />
        </FormField>

        <p v-if="runError" class="run-error">{{ runError }}</p>
        <p v-if="runResult && !runResult.ok" class="run-error">
          {{ $t("app.flowRunFailed", { index: runResult.index ?? 0, reason: runResult.reason ?? "" }) }}
        </p>
        <p v-else-if="runResult?.ok" class="run-ok">
          {{ $t("app.flowRunDone", { count: runResult.steps }) }}
        </p>
      </div>
      <template #footer>
        <span class="spacer"></span>
        <AppButton @click="running = null">{{ $t("app.close") }}</AppButton>
        <AppButton variant="primary" :disabled="store.busy === 'flow' || !runnableIdentities.length"
          @click="confirmRun">
          <Play :size="12" />
          {{ store.busy === "flow" ? $t("app.flowRunning") : $t("app.flowRun") }}
        </AppButton>
      </template>
    </Modal>

    <!-- Editor: the same shape the MCP tools write, so a flow saved by an AI can
         be opened and fixed here, and vice versa. -->
    <Modal
      v-if="editing"
      :open="true"
      :title="editing === 'new' ? $t('app.newFlow') : $t('app.editFlow')"
      width="760px"
      @close="editing = null"
    >
      <div class="editor">
        <div class="editor-row">
          <FormField grow :label="$t('app.flowName')">
            <TextField v-model="draft.name" type="text" :placeholder="$t('app.flowNamePlaceholder')" />
          </FormField>
          <FormField :label="$t('app.flowSite')">
            <SelectField
              :model-value="draft.siteId || undefined"
              :options="siteOptions"
              :aria-label="$t('app.flowSite')"
              @update:model-value="draft.siteId = $event ?? ''"
            />
          </FormField>
        </div>
        <FormField :label="$t('app.flowDescription')">
          <TextField
            v-model="draft.description"
            type="text"
            :placeholder="$t('app.flowDescriptionPlaceholder')"
          />
        </FormField>

        <div class="block">
          <div class="block-head">
            <span class="block-title">{{ $t("app.flowParams") }}</span>
            <LinkButton @click="addParam">
              <Plus :size="11" />
              {{ $t("app.flowParamAdd") }}
            </LinkButton>
          </div>
          <p v-if="!draft.params.length" class="hint">{{ $t("app.flowAddParamFirst") }}</p>
          <div v-for="(param, index) in draft.params" :key="index" class="param-row">
            <TextField v-model="param.name" mono type="text" :placeholder="$t('app.flowParamName')" />
            <TextField v-model="param.label" type="text" :placeholder="$t('app.flowParamLabel')" />
            <TextField v-model="param.default" type="text" :placeholder="$t('app.flowParamDefault')" />
            <Checkbox v-model="param.required">{{ $t("app.flowParamRequired") }}</Checkbox>
            <Checkbox v-model="param.secret">{{ $t("app.flowParamSecret") }}</Checkbox>
            <IconButton variant="danger" :ariaLabel="$t('app.flowParamRemove')" @click="draft.params.splice(index, 1)">
              <X :size="12" />
            </IconButton>
          </div>
        </div>

        <div class="block">
          <div class="block-head">
            <span class="block-title">{{ $t("app.flowSteps") }}</span>
            <LinkButton @click="addStep">
              <Plus :size="11" />
              {{ $t("app.flowStepAdd") }}
            </LinkButton>
          </div>
          <div
            v-for="(step, index) in draft.steps"
            :key="index"
            class="step-editor"
            :class="{ dragging: draggedStepIndex === index, drop: dropStepIndex === index }"
            @dragover="onStepDragOver(index, $event)"
            @dragleave="onStepDragLeave(index)"
            @drop.prevent="onStepDrop(index)"
          >
            <div class="step-top">
              <span
                class="step-grip"
                draggable="true"
                :title="$t('app.dragReorder')"
                :aria-label="$t('app.dragReorder')"
                @dragstart="onStepDragStart(index, $event)"
                @dragend="onStepDragEnd"
              >
                <GripVertical :size="12" />
              </span>
              <span class="step-index mono">{{ index + 1 }}</span>
              <SelectField
                :model-value="step.action"
                :options="FLOW_ACTIONS.map((a) => ({ value: a, label: actionLabel(a) }))"
                :aria-label="$t('app.flowStepAction')"
                @update:model-value="step.action = ($event as FlowStep['action']) ?? step.action"
              />
              <IconButton :ariaLabel="$t('app.flowStepAdd')"
                @click="moveStep(index, -1)">
                <ArrowRight :size="12" class="up" />
              </IconButton>
              <IconButton :ariaLabel="$t('app.flowStepAdd')"
                @click="moveStep(index, 1)">
                <ArrowRight :size="12" />
              </IconButton>
              <IconButton variant="danger" :ariaLabel="$t('app.flowStepRemove')" @click="removeStep(index)">
                <X :size="12" />
              </IconButton>
            </div>

            <div class="step-fields">
              <TextField
                v-if="step.action === 'navigate'"
                v-model="step.url"
                class="full"
                mono
                type="text"
                :placeholder="$t('app.flowStepUrl')"
              />
              <template v-if="needsTarget(step)">
                <TextField
                  v-model="step.label"
                  type="text"
                  :placeholder="$t('app.flowStepLabel')"
                  :disabled="step.action === 'click' && Boolean(step.text)"
                />
                <TextField
                  v-if="step.action === 'click' || step.action === 'read'"
                  v-model="step.text"
                  type="text"
                  :placeholder="$t('app.flowStepText')"
                />
                <TextField
                  v-model="step.selector"
                  mono
                  type="text"
                  :placeholder="$t('app.flowStepSelector')"
                />
              </template>
              <TextField
                v-if="step.action === 'fill'"
                v-model="step.value"
                mono
                type="text"
                :placeholder="$t('app.flowStepValue')"
              />
              <TextField
                v-if="step.action === 'select'"
                v-model="step.option"
                type="text"
                :placeholder="$t('app.flowStepOption')"
              />
              <SelectField
                v-if="step.action === 'press'"
                :model-value="step.key ?? 'Enter'"
                :options="FLOW_KEYS.map((k) => ({ value: k, label: k }))"
                :aria-label="$t('app.flowStepKey')"
                @update:model-value="step.key = $event ?? 'Enter'"
              />
              <template v-if="step.action === 'wait'">
                <SelectField
                  :model-value="step.condition ?? 'visible'"
                  :options="[
                    { value: 'visible', label: 'visible' },
                    { value: 'hidden', label: 'hidden' },
                    { value: 'text', label: 'text' },
                    { value: 'url', label: 'url' },
                    { value: 'value', label: 'value' },
                    { value: 'network-idle', label: 'network-idle' },
                  ]"
                  :aria-label="$t('app.flowStepCondition')"
                  @update:model-value="step.condition = ($event as FlowStep['condition'])"
                />
                <TextField
                  v-model="step.expect"
                  type="text"
                  :placeholder="$t('app.flowStepExpect')"
                />
                <Checkbox v-model="step.optional">{{ $t("app.flowStepOptional") }}</Checkbox>
              </template>
              <TextField
                v-if="step.action === 'read'"
                v-model="step.as"
                mono
                type="text"
                :placeholder="$t('app.flowStepAs')"
              />
            </div>
          </div>
        </div>
        <p v-if="editorError" class="run-error">{{ editorError }}</p>
      </div>
      <template #footer>
        <span class="spacer"></span>
        <AppButton @click="editing = null">{{ $t("app.cancel") }}</AppButton>
        <AppButton variant="primary" :disabled="store.busy === 'flow'"
          @click="saveDraft">
          {{ $t("app.save") }}
        </AppButton>
      </template>
    </Modal>
  </section>
</template>

<style scoped>
.flow-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  padding-right: 2px;
}

.flow-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 9px;
  border-radius: var(--radius);
  border: 1px solid transparent;
  text-align: left;
  color: var(--text-secondary);
}

.flow-row:hover {
  background: var(--surface-2);
}

.flow-row.selected {
  background: var(--surface-3);
  border-color: var(--line);
  color: var(--text);
}

.flow-copy {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.flow-name {
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.flow-sub {
  font-size: 10px;
  color: var(--faint);
}

.detail {
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-lg);
  background: var(--surface);
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 0;
  overflow-y: auto;
}

.detail-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.detail-copy h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 500;
}

.detail-sub {
  margin: 5px 0 0;
  font-size: 11.5px;
  color: var(--faint);
}

.detail-desc {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.6;
  max-width: 640px;
}

.detail-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
}

.icon-btn .up {
  transform: rotate(-90deg);
}

.block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.block-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.block-title {
  margin: 0;
  font-size: 10.5px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--faint);
}

.block-head .link-btn {
  margin-left: auto;
}

.param-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.param-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--bg-elevated);
  font-size: 11px;
}

.param-name {
  color: var(--text-secondary);
}

.param-label {
  color: var(--faint);
}

.param-flag {
  font-size: 9.5px;
  padding: 1px 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  color: var(--accent-text);
}

.steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.step {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  font-size: 12px;
}

.step:nth-child(odd) {
  background: color-mix(in srgb, var(--surface-2) 55%, transparent);
}

.step-index {
  width: 18px;
  color: var(--faint);
  font-size: 10px;
  flex: none;
}

.step-action {
  min-width: 62px;
  color: var(--text-secondary);
}

.step-target {
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.step-detail {
  color: var(--faint);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hint {
  margin: 0;
  font-size: 11px;
  color: var(--faint);
  line-height: 1.55;
}

/* Dialog bodies ------------------------------------------------------------ */

.run-form,
.editor {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: min(62vh, 560px);
  overflow-y: auto;
}

.editor-row {
  display: flex;
  gap: 10px;
}

/* The editor's fields are denser than a form's: a step row holds five of them
   and the dialog is already 760px of columns. */
.run-form :deep(.field),
.editor :deep(.field) {
  gap: 5px;
}

.run-form :deep(.label),
.editor :deep(.label) {
  font-size: 11px;
  letter-spacing: 0;
  text-transform: none;
  color: var(--faint);
}

.field-var {
  font-size: 10px;
  color: var(--muted);
}

.run-form :deep(.input),
.editor :deep(.input) {
  padding: 6px 9px;
  font-size: 12px;
}

.run-note {
  margin: 0;
  font-size: 11.5px;
  color: var(--faint);
}

.run-error {
  margin: 0;
  font-size: 11.5px;
  color: var(--red);
  line-height: 1.5;
}

.run-ok {
  margin: 0;
  font-size: 11.5px;
  color: var(--green);
}

.param-row {
  display: grid;
  grid-template-columns: 110px 1fr 1fr auto auto auto;
  gap: 6px;
  align-items: center;
}

/* The two checkboxes are the densest in the app: they share a row with three
   inputs, so they take the quieter colour the editor uses for its captions. */
.param-row :deep(.check) {
  font-size: 11px;
  color: var(--faint);
}

.step-editor {
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

/* Drag handle: rows are full of inputs, so only the grip starts a drag. */
.step-grip {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  color: var(--faint);
  cursor: grab;
}

.step-grip:active {
  cursor: grabbing;
}

.step-editor.dragging {
  opacity: 0.5;
}

/* Insertion line at the top of the step the drag would land on. */
.step-editor.drop {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--line));
  box-shadow: inset 0 2px 0 var(--accent);
}

.step-top {
  display: flex;
  align-items: center;
  gap: 8px;
}

.step-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.step-fields :deep(.input) {
  flex: 1 1 160px;
  min-width: 120px;
}

.step-fields .full {
  flex: 1 1 100%;
}
</style>
