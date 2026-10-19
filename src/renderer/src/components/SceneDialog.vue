<script setup lang="ts">
import { reactive, watch } from "vue";
import { Trash2 } from "lucide-vue-next";
import Modal from "./Modal.vue";
import type { Identity, LayoutKey, SceneDraft } from "@shared/types";

const props = defineProps<{
  draft: SceneDraft;
  identities: Identity[];
}>();

const emit = defineEmits<{
  close: [];
  save: [draft: SceneDraft];
  delete: [];
}>();

const form = reactive<SceneDraft>({ ...props.draft, identityIds: [...props.draft.identityIds] });
const error = reactive<{ message: string | null }>({ message: null });

watch(
  () => props.draft,
  (next) => Object.assign(form, next, { identityIds: [...next.identityIds] }),
);

const layoutOptions: Array<{ value: LayoutKey; label: string }> = [
  { value: "1x1", label: "1 × 1" },
  { value: "2x1", label: "2 × 1" },
  { value: "2x2", label: "2 × 2" },
  { value: "3x1", label: "3 × 1" },
];

function toggle(id: string) {
  if (form.identityIds.includes(id)) {
    form.identityIds = form.identityIds.filter((item) => item !== id);
  } else {
    form.identityIds = [...form.identityIds, id];
  }
}

function submit() {
  error.message = null;
  if (!form.name.trim()) {
    error.message = "请填写场景名称";
    return;
  }
  if (form.identityIds.length === 0) {
    error.message = "至少选择一个身份";
    return;
  }
  emit("save", { ...form, name: form.name.trim() });
}
</script>

<template>
  <Modal
    :open="true"
    :title="form.id ? '编辑场景' : '新建场景'"
    description="场景把常一起测试的身份编成一组，启动时按布局平铺窗口。"
    width="580px"
    @close="emit('close')"
  >
    <div class="form">
      <label class="field">
        <span class="label">场景名称</span>
        <input v-model="form.name" class="input" placeholder="例如：权限矩阵 · 主流程" />
      </label>

      <div class="field">
        <span class="label">成员（至少一个）</span>
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
        <p v-if="!identities.length" class="note">当前环境还没有身份，请先创建身份。</p>
      </div>

      <div class="field">
        <span class="label">窗口布局</span>
        <div class="layouts">
          <button
            v-for="option in layoutOptions"
            :key="option.value"
            type="button"
            class="layout-btn mono"
            :class="{ on: form.layout === option.value }"
            @click="form.layout = option.value"
          >
            {{ option.label }}
          </button>
        </div>
      </div>

      <p class="note">启动顺序按选择顺序执行，间隔约 350ms，避免设备瞬时过载。</p>
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
  max-height: 220px;
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
  gap: 4px;
}

.layout-btn {
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--faint);
  font-size: 11px;
  padding: 5px 8px;
}

.layout-btn.on {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-foreground);
  font-weight: 500;
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
}

.btn.primary {
  background: linear-gradient(180deg, var(--accent-strong), color-mix(in srgb, var(--accent) 88%, black));
  border-color: color-mix(in srgb, var(--accent) 80%, black);
  color: var(--accent-foreground);
  font-weight: 500;
}

.btn.danger {
  color: var(--red);
  border-color: color-mix(in srgb, var(--red) 34%, var(--line));
}

.spacer {
  flex: 1;
}
</style>
