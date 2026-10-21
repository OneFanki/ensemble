import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import OverlayApp from "./overlay/OverlayApp.vue";
import FocusLabelApp from "./overlay/FocusLabelApp.vue";
import { i18n } from "./i18n";
import "./styles/tokens.css";
import "./styles/base.css";

// The control panel, the always-on-top switcher and the transient identity label
// share one built bundle and one preload; the hash decides which root to mount.
// All roots are imported statically so the packaged build never has to fetch a
// second chunk over file://, where module requests are not guaranteed to resolve.
const hash = window.location.hash;
const root = hash.includes("focus-label")
  ? { name: "focus-label", component: FocusLabelApp }
  : hash.includes("overlay")
    ? { name: "overlay", component: OverlayApp }
    : { name: "app", component: App };
if (root.name !== "app") document.documentElement.dataset["mode"] = root.name;

createApp(root.component).use(createPinia()).use(i18n).mount("#app");
