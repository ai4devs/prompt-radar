// Two entry points:
//   1. src/extension.ts  -> dist/extension.js   (Node CJS, consumed by VS Code)
//   2. src/webview/radar.ts -> dist/webview/radar.js (browser IIFE, loaded inside the webview)
// Run with `node esbuild.js` (build once) or `node esbuild.js --watch` (rebuild on change).

const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

// The scanner parses source with tree-sitter via WASM. The runtime + grammar
// .wasm files ship inside the .vsix and are located at runtime relative to dist/
// (see src/scanner/ast/runtime.ts). Copy them out of node_modules into dist/wasm/.
const WASM_FILES = [
  "tree-sitter.wasm",
  "tree-sitter-python.wasm",
  "tree-sitter-javascript.wasm",
  "tree-sitter-typescript.wasm",
  "tree-sitter-tsx.wasm",
  "tree-sitter-java.wasm",
  "tree-sitter-c-sharp.wasm",
];

function copyWasm() {
  const wasmSrc = path.join(
    path.dirname(require.resolve("@vscode/tree-sitter-wasm/package.json")),
    "wasm"
  );
  const wasmOut = path.join("dist", "wasm");
  fs.mkdirSync(wasmOut, { recursive: true });
  for (const file of WASM_FILES) {
    fs.copyFileSync(path.join(wasmSrc, file), path.join(wasmOut, file));
  }
  console.log(`Copied ${WASM_FILES.length} tree-sitter wasm files to dist/wasm/`);
}

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: ["src/webview/radar.ts"],
  bundle: true,
  outfile: "dist/webview/radar.js",
  format: "iife",
  platform: "browser",
  target: "es2022",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

async function main() {
  copyWasm();
  if (watch) {
    const extCtx = await esbuild.context(extensionConfig);
    const wvCtx = await esbuild.context(webviewConfig);
    await Promise.all([extCtx.watch(), wvCtx.watch()]);
    console.log("Watching for changes...");
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(webviewConfig),
    ]);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
