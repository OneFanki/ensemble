export type CoreLocale = "zh" | "en";

const messages = {
  zh: {
    "menu.settings": "设置…",
    "menu.window": "窗口",
    "vault.basicText":
      "当前系统没有可用的密钥环，凭据只做了弱加密。建议安装系统密钥环，或在设置中为 Ensemble 设置主密码。",
    "vault.unavailable": "凭据存储不可用，密码不会被保存。",
    "vault.locked": "凭据库已锁定，请先输入主密码解锁。",
    "vault.legacyPlain": "检测到旧版本保存的明文凭据，已自动迁移；建议设置主密码。",
    "vault.masterTooShort": "主密码至少 8 位。",
    "vault.wrongPassword": "主密码不正确。",
    "error.siteMissing": "站点不存在，可能已被删除。",
    "error.copySameSite": "不能复制到同一个站点。",
    "error.copyNoMembers": "没有可复制到目标站点的成员。",
    "error.referenceMissing": "引用的账号不存在或没有可用的密码。",
    "error.referenceSelf": "不能引用自己。",
    "error.referenceChain": "被引用的账号本身也是引用，不能形成引用链。",
    "error.referenceHasDependents": "已有账号引用这个账号，不能把它改成引用别人。",
    "error.tagName": "请填写标签名称。",
    "error.tagDuplicate": "已有同名标签，请换一个名字。",
    "error.tagMissing": "标签不存在，可能已被删除。",
    "error.identityMissing": "身份不存在，可能已被删除。",
    "error.viewMissing": "视图不存在，可能已被删除。",
    "error.viewMembers": "视图至少需要一个可用身份。",
    "error.batchMixedSites": "批量启动只能选择同一个站点下的身份。",
    "error.layoutName": "请填写布局名称。",
    "error.layoutSlots": "布局至少需要一个槽位。",
    "error.layoutMissing": "布局预设不存在，可能已被删除。",
    "error.importNeedsPassphrase": "该配置文件包含加密的密码，请先输入导出时设置的口令。",
    "error.importPassphrase": "口令不正确，或配置文件中的密码部分已损坏。",
    "error.noEngine": "没有可用的浏览器引擎，请先在设置中扫描。",
    "error.engineBlocked": "该浏览器引擎不可用。",
    "error.noPassword": "没有可用的密码。请为该身份或所在站点设置密码。",
    "error.fillFailed": "未能填充登录表单（{reason}）。请确认登录页已经打开。",
    "auth.noCheckPath": "未配置登录状态检测地址。",
    "auth.notRunning": "该身份未在运行，无法检测。",
    "auth.noHeadless": "{brand} 不支持后台检测；请先启动该身份，再在窗口内检测。",
    "auth.noCdp": "该身份以外部模式运行，无法检测或自动填充。",
    "auth.crossOrigin": "当前页面不属于该站点的域名，已拒绝操作。",
    "auth.originChanged": "该站点的地址与上次使用密码时不同，已暂停填写。请在站点设置里确认地址后再试。",
    "auth.filled": "已填充账号与密码，请手动提交。",
    "auth.filledSubmitted": "已填充并提交登录表单。",
    "auth.missingFields": "未找到字段：{fields}",
    "auth.unmatchedFields": "页面还有未配置的字段：{fields}",
    "instance.cleanLabel": "干净会话",
  },
  en: {
    "menu.settings": "Settings…",
    "menu.window": "Window",
    "vault.basicText":
      "No system keyring is available, so credentials are only weakly encrypted. Consider installing a keyring or setting a master password.",
    "vault.unavailable": "Credential storage is unavailable; passwords will not be saved.",
    "vault.locked": "The vault is locked. Enter your master password to unlock it.",
    "vault.legacyPlain":
      "Plaintext credentials from an older version were found and migrated. Setting a master password is recommended.",
    "vault.masterTooShort": "The master password must be at least 8 characters.",
    "vault.wrongPassword": "Incorrect master password.",
    "error.siteMissing": "Site not found. It may have been deleted.",
    "error.copySameSite": "A view cannot be copied to its own site.",
    "error.copyNoMembers": "No member could be matched or created on the target site.",
    "error.referenceMissing": "The referenced account does not exist or has no usable password.",
    "error.referenceSelf": "An identity cannot reference itself.",
    "error.referenceChain": "The referenced account is itself a reference; chains are not allowed.",
    "error.referenceHasDependents":
      "Other identities reference this one, so it cannot become a reference itself.",
    "error.tagName": "Enter a tag name.",
    "error.tagDuplicate": "A tag with that name already exists.",
    "error.tagMissing": "Tag not found. It may have been deleted.",
    "error.identityMissing": "Identity not found. It may have been deleted.",
    "error.viewMissing": "View not found. It may have been deleted.",
    "error.viewMembers": "A view needs at least one available identity.",
    "error.batchMixedSites": "A batch launch can only include identities from one site.",
    "error.layoutName": "Enter a layout name.",
    "error.layoutSlots": "A layout needs at least one slot.",
    "error.layoutMissing": "Layout preset not found. It may have been deleted.",
    "error.importNeedsPassphrase":
      "This file contains encrypted passwords. Enter the passphrase used when exporting it.",
    "error.importPassphrase":
      "The passphrase is wrong, or the encrypted section of the file is corrupted.",
    "error.noEngine": "No browser engine available. Scan engines in settings first.",
    "error.engineBlocked": "This browser engine is unavailable.",
    "error.noPassword": "No password available. Set one for this identity or its site.",
    "error.fillFailed":
      "Could not fill the login form ({reason}). Make sure the login page is open.",
    "auth.noCheckPath": "No auth check endpoint configured.",
    "auth.notRunning": "This identity is not running, so it cannot be checked.",
    "auth.noHeadless": "{brand} cannot be checked in the background; launch the identity and check its window instead.",
    "auth.noCdp": "This identity runs in external mode; checking and autofill are unavailable.",
    "auth.crossOrigin": "The current page is not on this site's origin; operation refused.",
    "auth.originChanged": "This site's address differs from the one its password was last used with. Filling was paused; confirm the address in the site settings and try again.",
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
