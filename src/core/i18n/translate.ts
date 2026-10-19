export type CoreLocale = "zh" | "en";

const messages = {
  zh: {
    "vault.basicText":
      "当前系统没有可用的密钥环，凭据只做了弱加密。建议安装系统密钥环，或在设置中为 Ensemble 设置主密码。",
    "vault.unavailable": "凭据存储不可用，密码不会被保存。",
    "vault.locked": "凭据库已锁定，请先输入主密码解锁。",
    "vault.legacyPlain": "检测到旧版本保存的明文凭据，已自动迁移；建议设置主密码。",
    "vault.masterTooShort": "主密码至少 8 位。",
    "vault.wrongPassword": "主密码不正确。",
    "error.environmentMissing": "环境不存在，可能已被删除。",
    "error.identityMissing": "身份不存在，可能已被删除。",
    "error.sceneMissing": "场景不存在，可能已被删除。",
    "error.sceneMembers": "场景至少需要一个可用身份。",
    "error.noEngine": "没有可用的浏览器引擎，请先在设置中扫描。",
    "error.engineBlocked": "该浏览器引擎不可用。",
    "error.noPassword": "没有可用的密码。请为该身份或所在环境设置密码。",
    "error.fillFailed": "未能填充登录表单（{reason}）。请确认登录页已经打开。",
    "auth.noCheckPath": "未配置登录状态检测地址。",
    "auth.notRunning": "该身份未在运行，无法检测。",
    "auth.noCdp": "该身份以外部模式运行，无法检测或自动填充。",
    "auth.crossOrigin": "当前页面不属于该环境的域名，已拒绝操作。",
    "auth.filled": "已填充账号与密码，请手动提交。",
    "auth.filledSubmitted": "已填充并提交登录表单。",
    "auth.missingFields": "未找到字段：{fields}",
    "auth.unmatchedFields": "页面还有未配置的字段：{fields}",
    "instance.cleanLabel": "干净会话",
  },
  en: {
    "vault.basicText":
      "No system keyring is available, so credentials are only weakly encrypted. Consider installing a keyring or setting a master password.",
    "vault.unavailable": "Credential storage is unavailable; passwords will not be saved.",
    "vault.locked": "The vault is locked. Enter your master password to unlock it.",
    "vault.legacyPlain":
      "Plaintext credentials from an older version were found and migrated. Setting a master password is recommended.",
    "vault.masterTooShort": "The master password must be at least 8 characters.",
    "vault.wrongPassword": "Incorrect master password.",
    "error.environmentMissing": "Environment not found. It may have been deleted.",
    "error.identityMissing": "Identity not found. It may have been deleted.",
    "error.sceneMissing": "Scene not found. It may have been deleted.",
    "error.sceneMembers": "A scene needs at least one available identity.",
    "error.noEngine": "No browser engine available. Scan engines in settings first.",
    "error.engineBlocked": "This browser engine is unavailable.",
    "error.noPassword": "No password available. Set one for this identity or its environment.",
    "error.fillFailed":
      "Could not fill the login form ({reason}). Make sure the login page is open.",
    "auth.noCheckPath": "No auth check endpoint configured.",
    "auth.notRunning": "This identity is not running, so it cannot be checked.",
    "auth.noCdp": "This identity runs in external mode; checking and autofill are unavailable.",
    "auth.crossOrigin": "The current page is not on this environment's origin; operation refused.",
    "auth.filled": "Username and password filled. Submit manually.",
    "auth.filledSubmitted": "Login form filled and submitted.",
    "auth.missingFields": "Fields not found: {fields}",
    "auth.unmatchedFields": "Unconfigured fields on the page: {fields}",
    "instance.cleanLabel": "Clean session",
  },
} as const;

export type CoreMessageKey = keyof (typeof messages)["zh"];

let locale: CoreLocale = "zh";

export function setCoreLocale(next: CoreLocale): void {
  locale = next;
}

export function t(key: CoreMessageKey, params?: Record<string, string>): string {
  const template = messages[locale][key] ?? messages.zh[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match);
}
