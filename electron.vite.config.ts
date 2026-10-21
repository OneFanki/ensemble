import { resolve } from "node:path";
import vue from "@vitejs/plugin-vue";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const sharedAliases = {
  "@core": resolve("src/core"),
  "@shared": resolve("src/shared"),
};

export default defineConfig({
  main: {
    // Bundle every dependency into the main-process output so the installer
    // ships no node_modules at all; only `electron` stays external.
    plugins: [externalizeDepsPlugin({ exclude: ["zod"] })],
    resolve: { alias: sharedAliases },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAliases },
  },
  renderer: {
    resolve: {
      alias: {
        ...sharedAliases,
        "@renderer": resolve("src/renderer/src"),
      },
    },
    plugins: [vue()],
  },
});
