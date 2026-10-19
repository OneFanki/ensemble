import { resolve } from "node:path";
import vue from "@vitejs/plugin-vue";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const sharedAliases = {
  "@core": resolve("src/core"),
  "@shared": resolve("src/shared"),
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
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
