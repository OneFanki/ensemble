/**
 * The presentation and behaviour of one message row, shared by its two homes.
 *
 * Messages are read in two places — the message centre page and the bell's
 * popover in the toolbar — and every part of a row that is not layout is the
 * same in both: the headline has to be translated from a stored i18n key, the
 * icon follows the kind (and, for app rows, the tone), the timestamp is
 * shortened, a row whose target is gone has to say why, and running a row's
 * action means the same three things. Two copies of that would drift the moment
 * one of them gained a fourth kind.
 *
 * Only what is genuinely shared lives here. The page keeps its filters and its
 * bulk actions; the popover keeps its own size and its footer.
 */
import type { AppMessageView, LoginCaptureNotice, MessageKind } from "@shared/types";
import {
  Bot,
  CircleAlert,
  CircleCheck,
  Globe,
  Info,
  KeyRound,
  TriangleAlert,
} from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { useEmbeddedStore } from "../stores/embedded";
import { useWorkspaceStore } from "../stores/workspace";

export const MESSAGE_KINDS: MessageKind[] = ["login-capture", "account", "ai", "app"];

/** Filter labels, named explicitly rather than built from the kind id.
 *  Deriving them from the string ("login-capture" → "logincapture") produced
 *  keys that exist but read like a machine made them. */
export const MESSAGE_KIND_LABELS: Record<MessageKind, string> = {
  "login-capture": "app.messageKindLoginCapture",
  account: "app.messageKindAccount",
  ai: "app.messageKindAi",
  app: "app.messageKindApp",
};

const KIND_ICONS = {
  "login-capture": KeyRound,
  account: Globe,
  ai: Bot,
  app: Info,
} as const;

export interface MessageRows {
  /** The headline, translated. A key that no longer exists shows its detail
   *  instead of a raw `messages.x` — history survives releases that rename copy. */
  titleOf: (message: AppMessageView) => string;
  /** The icon for a row: by kind, except app rows which carry a tone. */
  iconOf: (message: AppMessageView) => unknown;
  /** A short timestamp: a time for today, date + time for older rows. */
  whenOf: (message: AppMessageView) => string;
  /** Why a row can no longer act. */
  staleReason: (message: AppMessageView) => string;
  /** The action's own label, which is what the row's button says. */
  actionLabelOf: (message: AppMessageView) => string;
  /** Runs a row's action and marks it read. */
  act: (message: AppMessageView) => Promise<void>;
}

/**
 * @param saveCapture Handed to the shell, which owns the account dialog and the
 *   site auto-creation. The row only knows which capture it points at.
 */
export function useMessageRows(saveCapture: (notice: LoginCaptureNotice) => void): MessageRows {
  const store = useWorkspaceStore();
  const embedded = useEmbeddedStore();
  const { t, te } = useI18n();

  function iconOf(message: AppMessageView) {
    if (message.kind !== "app") return KIND_ICONS[message.kind];
    if (message.tone === "error") return CircleAlert;
    if (message.tone === "warning") return TriangleAlert;
    if (message.tone === "success") return CircleCheck;
    return KIND_ICONS.app;
  }

  function actionLabelOf(message: AppMessageView): string {
    if (message.kind === "login-capture") return t("app.loginCaptureSave");
    if (message.kind === "ai") return t("app.messageGotoTab");
    return t("app.messageRelogin");
  }

  /**
   * Runs a row's action.
   *
   * Each kind means a different "show me": a capture opens the account form, an
   * account reopens its login page, an AI row switches to the page it touched.
   * The row is marked read on the way, because using it is the strongest
   * possible statement that it was seen.
   */
  async function act(message: AppMessageView): Promise<void> {
    if (message.stale || !message.action) return;
    void store.markMessageRead(message.id);
    if (message.action.type === "login-capture") {
      const notice = store.pendingLogins.find(
        (item) => item.token === (message.action as { token: string }).token,
      );
      if (notice) saveCapture(notice);
      return;
    }
    if (message.action.type === "identity") {
      const { identityId } = message.action;
      const identity = store.identities.find((item) => item.id === identityId);
      if (!identity) return;
      // Opening the account is the fix for every reason a login failed: it puts
      // the login page on screen with the saved password already typed.
      await embedded.openIdentity(identityId);
      return;
    }
    await embedded.activate(message.action.tabId);
  }

  return {
    titleOf(message) {
      if (!te(message.titleKey)) return message.detail ?? message.titleKey;
      return t(message.titleKey, message.titleParams ?? {});
    },
    iconOf,
    whenOf(message) {
      const at = new Date(message.at);
      if (Number.isNaN(at.getTime())) return "";
      const sameDay = new Date().toDateString() === at.toDateString();
      return sameDay
        ? at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
        : at.toLocaleString(undefined, {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          });
    },
    /**
     * Why a row can no longer act.
     *
     * The two cases differ and the difference matters: a capture's secret is
     * only ever held in memory, so a row from a previous run is unrecoverable by
     * design (nothing was written to disk); a tab or an identity simply is not
     * there any more. Saying "expired" for both would suggest the password might
     * still be somewhere.
     */
    staleReason(message) {
      if (message.action?.type === "login-capture") return t("app.messageStaleCapture");
      return t("app.messageStaleTarget");
    },
    actionLabelOf,
    act,
  };
}
