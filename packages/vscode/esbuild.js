// Two entry points:
//   1. src/extension.ts  -> dist/extension.js   (Node CJS, consumed by VS Code)
//   2. src/webview/radar.ts -> dist/webview/radar.js (browser IIFE, loaded inside the webview)
// Run with `node esbuild.js` (build once) or `node esbuild.js --watch` (rebuild on change).

const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

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
