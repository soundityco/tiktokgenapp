// Mac: the app signed "ad hoc" (no Apple account): a Mac with Apple chip runs nothing unsigned, and the build changed the
// app's files after Electron's own signature. The first opening still asks to allow it (System Settings).
const { execFileSync } = require("node:child_process");
const path = require("node:path");
exports.default = async (ctx) => {
  if (ctx.electronPlatformName !== "darwin") return;
  const appPath = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
};
