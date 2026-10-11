// Produces out/MideaBar-darwin-<arch>/MideaBar.app. Works from macOS or Linux.
import { packager } from "@electron/packager";

const arch = process.env.MIDEABAR_ARCH ?? (process.platform === "darwin" ? process.arch : "arm64");

const [out] = await packager({
  dir: ".",
  name: "MideaBar",
  platform: "darwin",
  arch,
  out: "out",
  overwrite: true,
  // Plain files rather than an archive: the tray icon and its @2x variant are
  // loaded by native code, which wants real paths.
  asar: false,
  prune: true,
  icon: "assets/icon.icns",
  appBundleId: "com.rubiv.mideabar",
  appCategoryType: "public.app-category.utilities",
  // Everything is bundled into dist/, so ship only that plus the icons.
  ignore: (path) => path !== "" && !/^\/(package\.json|dist|assets)(\/|$)/.test(path),
  extendInfo: {
    // Menu bar only: no Dock icon, no app switcher entry.
    LSUIElement: true,
    NSLocalNetworkUsageDescription:
      "MideaBar talks to your air conditioner directly over your Wi-Fi network.",
  },
  // Behind a proxy the downloader cannot reach GitHub; point this at a folder
  // holding electron-v<version>-darwin-<arch>.zip instead.
  ...(process.env.MIDEABAR_ELECTRON_ZIPS ? { electronZipDir: process.env.MIDEABAR_ELECTRON_ZIPS } : {}),
  // On a Mac, give the bundle a local ad-hoc signature so it opens without fuss.
  ...(process.platform === "darwin" ? { osxSign: { identity: "-" } } : {}),
});

console.log(`packaged ${out}/MideaBar.app (${arch})`);
