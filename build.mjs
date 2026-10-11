// Bundles everything into dist/ so the packaged app carries no node_modules.
import { build } from "esbuild";
import { chmodSync, cpSync, mkdirSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/renderer", { recursive: true });

const node = { bundle: true, platform: "node", target: "node22", format: "cjs", logLevel: "warning" };

await Promise.all([
  build({ ...node, entryPoints: ["src/main/main.ts"], outfile: "dist/main.cjs", external: ["electron"] }),
  build({ ...node, entryPoints: ["src/main/preload.ts"], outfile: "dist/preload.cjs", external: ["electron"] }),
  build({ ...node, entryPoints: ["src/cli.ts"], outfile: "dist/cli.cjs", banner: { js: "#!/usr/bin/env node" } }),
  build({
    bundle: true,
    platform: "browser",
    target: "chrome130",
    format: "iife",
    logLevel: "warning",
    entryPoints: ["src/renderer/renderer.ts"],
    outfile: "dist/renderer/renderer.js",
  }),
]);

cpSync("src/renderer/index.html", "dist/renderer/index.html");
cpSync("src/renderer/style.css", "dist/renderer/style.css");
chmodSync("dist/cli.cjs", 0o755);
console.log("built dist/");
