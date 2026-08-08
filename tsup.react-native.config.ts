import { defineConfig } from "tsup";

/**
 * Fully-bundled ESM for Metro / React Native: inlines `@noble/hashes` and avoids
 * Node built-ins. The default `dist/index.js` keeps hashes external for Bun/Node.
 */
export default defineConfig({
  entry: { "react-native": "src/react-native.ts" },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  splitting: false,
  platform: "neutral",
  target: "es2022",
  noExternal: [/.*/],
});
