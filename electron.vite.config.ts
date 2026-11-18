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
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/preload/index.ts"),
          // 拆出窗口的容器 preload：只暴露 guest 生命周期通道。
          popout: resolve("src/preload/popout.ts"),
        },
        // CJS，两种宿主都需要：弹窗窗口开 `sandbox: true`，而 sandbox 的
        // preload 只加载 CommonJS；主窗口虽是 sandbox: false，CJS 照常可用。
        // 扩展名必须是 `.cjs`——package.json 声明 `type: "module"`，`.js` 会被
        // 当成 ESM，preload 里没有 require。
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
          chunkFileNames: "chunks/[name].cjs",
        },
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        ...sharedAliases,
        "@renderer": resolve("src/renderer/src"),
      },
    },
    plugins: [vue()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/renderer/index.html"),
          // 拆出窗口的容器页：不走 Vue 应用，独立入口把这片代码与浏览器页
          // UI 的改动面隔开。
          popout: resolve("src/renderer/popout.html"),
        },
      },
    },
  },
});
