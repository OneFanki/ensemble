<script setup lang="ts">
import { reactive, ref, watch } from "vue";
import { Eye, EyeOff, Trash2 } from "lucide-vue-next";
import Modal from "./Modal.vue";
import { ROLE_COLORS } from "@shared/defaults";
import { useWorkspaceStore } from "../stores/workspace";
import type { Engine, IdentityDraft, RoleColor } from "@shared/types";

const props = defineProps<{
  draft: IdentityDraft;
  engines: Engine[];
  passwordSet: boolean;
}>();

const emit = defineEmits<{
  close: [];
  save: [draft: IdentityDraft];
  delete: [];
}>();

const store = useWorkspaceStore();
const form = reactive<IdentityDraft>({ ...props.draft });
const password = ref("");
const reveal = ref(false);
const error = ref<string | null>(null);

watch(
  () => props.draft,
  (next) => {
    Object.assign(form, next);
    password.value = "";
  },
);

const colorLabels: Record<RoleColor, string> = {
  amber: "琥珀",
  teal: "青",
  violet: "紫",
  rose: "玫",
  blue: "蓝",
  slate: "灰",
};

function submit() {
  error.value = null;
  if (!form.name.trim()) {
    error.value = "请填写显示名称";
    return;
  }
  if (!form.username.trim()) {
    error.value = "请填写账号";
    return;
  }
  emit("save", {
    ...form,
    name: form.name.trim(),
    username: form.username.trim(),
    role: form.role.trim() || "member",
    password: password.value || undefined,
  });
}

async function saveEnvironmentPassword() {
  const envId = form.environmentId;
  if (!password.value) {
    error.value = "请输入密码后再保存到环境";
    return;
  }
  await store.setPassword({ kind: "environment", id: envId }, password.value);
  password.value = "";
}

async function copyDefaultPassword() {
  await store.copyPassword({ kind: "environment", id: form.environmentId });
}
</script>

<template>
  <Modal
    :open="true"
    :title="form.id ? '编辑身份' : '新建身份'"
    description="一个身份对应一个独立的浏览器 profile，账号与登录态互不影响。"
    width="600px"
    @close="emit('close')"
  >
    <div class="form">
      <div class="row">
        <label class="field grow">
          <span class="label">显示名称</span>
          <input v-model="form.name" class="input" placeholder="例如：管理员 · 主账号" />
        </label>
        <label class="field" style="width: 150px">
          <span class="label">角色</span>
          <input v-model="form.role" class="input" list="role-suggestions" placeholder="admin" />
          <datalist id="role-suggestions">
            <option value="admin" />
            <option value="editor" />
            <option value="viewer" />
            <option value="reviewer" />
            <option value="ops" />
          </datalist>
        </label>
      </div>

      <label class="field">
        <span class="label">账号</span>
        <input v-model="form.username" class="input mono" placeholder="admin@test.local" />
      </label>

      <div class="field">
        <span class="label">身份色</span>
        <div class="colors">
          <button
            v-for="color in ROLE_COLORS"
            :key="color"
            type="button"
            class="color"
            :class="{ on: form.color === color }"
            :style="{ '--role': `var(--role-${color})` }"
            :aria-label="colorLabels[color]"
            :title="colorLabels[color]"
            @click="form.color = color"
          ></button>
        </div>
      </div>

      <div class="field">
        <span class="label">凭据</span>
        <div class="segmented">
          <button
            type="button"
            class="seg"
            :class="{ on: form.passwordMode === 'inherit' }"
            @click="form.passwordMode = 'inherit'"
          >
            继承环境默认
          </button>
          <button
            type="button"
            class="seg"
            :class="{ on: form.passwordMode === 'custom' }"
            @click="form.passwordMode = 'custom'"
          >
            自定义密码
          </button>
        </div>
      </div>

      <div class="password-row">
        <div class="pw-input">
          <input
            v-model="password"
            class="input mono"
            :type="reveal ? 'text' : 'password'"
            :placeholder="form.passwordMode === 'inherit' ? '覆盖环境默认密码（留空则继续继承）' : '设置该身份的密码'"
            autocomplete="new-password"
          />
          <button
            type="button"
            class="pw-btn"
            :aria-label="reveal ? $t('app.hide') : $t('app.show')"
            @click="reveal = !reveal"
          >
            <EyeOff v-if="reveal" :size="13" />
            <Eye v-else :size="13" />
          </button>
        </div>
        <button
          v-if="form.passwordMode === 'inherit'"
          type="button"
          class="btn"
          :disabled="!password"
          @click="saveEnvironmentPassword"
        >
          存为环境默认
        </button>
        <button
          v-else
          type="button"
          class="btn"
          :disabled="!password"
          @click="store.setPassword({ kind: 'identity', id: form.id! }, password); password = ''"
        >
          立即保存到身份
        </button>
        <button
          v-if="form.passwordMode === 'inherit'"
          type="button"
          class="btn ghost"
          @click="copyDefaultPassword"
        >
          复制默认密码
        </button>
      </div>

      <p class="note">
        <template v-if="form.passwordMode === 'inherit'">
          未设置自定义密码时使用环境的默认密码。修改环境默认密码会自动影响所有继承者。
        </template>
        <template v-else>
          自定义密码只对该身份生效。留空表示保持已保存的密码不变。
        </template>
      </p>

      <div class="row">
        <label class="field grow">
          <span class="label">起始路径</span>
          <input v-model="form.startPath" class="input mono" placeholder="/" />
        </label>
        <label class="field grow">
          <span class="label">引擎（可选覆盖）</span>
          <select v-model="form.engineId" class="input">
            <option :value="undefined">继承环境默认</option>
            <option v-for="engine in engines" :key="engine.id" :value="engine.id">
              {{ engine.brand }} {{ engine.version ?? "" }}
            </option>
          </select>
        </label>
      </div>

      <label class="field">
        <span class="label">备注（可选）</span>
        <input v-model="form.note" class="input" placeholder="例如：这个账号开了双因素验证" />
      </label>

      <p v-if="error" class="error" role="alert">{{ error }}</p>
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
  gap: 13px;
}

.row {
  display: flex;
  gap: 12px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.grow {
  flex: 1 1 0;
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

.colors {
  display: flex;
  gap: 6px;
}

.color {
  --role: var(--role-slate);
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--role) 30%, transparent);
  border: 1px solid color-mix(in srgb, var(--role) 50%, transparent);
  position: relative;
}

.color.on::after {
  content: "";
  position: absolute;
  inset: 5px;
  border-radius: 3px;
  background: var(--role);
}

.segmented {
  display: flex;
  gap: 2px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  padding: 2px;
  align-self: flex-start;
}

.seg {
  padding: 5px 10px;
  border-radius: 3px;
  font-size: 11px;
  color: var(--muted);
}

.seg.on {
  background: var(--surface-3);
  color: var(--text);
}

.password-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.pw-input {
  position: relative;
  flex: 1 1 auto;
}

.pw-input .input {
  padding-right: 30px;
}

.pw-btn {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  width: 24px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 4px;
  color: var(--faint);
}

.pw-btn:hover {
  color: var(--text-secondary);
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
  padding: 7px 11px;
  font-size: 11.5px;
  border: 1px solid var(--line);
  background: var(--surface-2);
  color: var(--text-secondary);
  white-space: nowrap;
}

.btn:hover:not(:disabled) {
  background: var(--surface-3);
}

.btn.ghost {
  background: transparent;
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
