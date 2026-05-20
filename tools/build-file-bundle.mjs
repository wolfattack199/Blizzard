import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = path.join(root, "index.html");
const outFileName = ".blizzard-file-bundle.tmp.js";
const outPath = path.join(root, outFileName);
const args = [
  "--yes",
  "esbuild@0.28.0",
  "js/main.js",
  "--bundle",
  "--format=esm",
  "--platform=browser",
  "--target=es2020",
  "--charset=ascii",
  "--legal-comments=none",
  "--external:https://www.gstatic.com/firebasejs/*",
  `--outfile=${outFileName}`
];

if (process.platform === "win32") {
  const command = ["npx.cmd", ...args].join(" ");
  execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], { cwd: root, stdio: "inherit" });
} else {
  execFileSync("npx", args, { cwd: root, stdio: "inherit" });
}

const bundle = readFileSync(outPath, "utf8")
  .replace(/<\/script/gi, "<\\/script")
  .trimEnd();

const html = readFileSync(indexPath, "utf8");
const bundleBlock = /(  <!-- BLIZZARD_FILE_BUNDLE_START -->\r?\n  <script type="text\/plain" id="blizzard-file-bundle">\r?\n)[\s\S]*?(  <\/script>\r?\n  <!-- BLIZZARD_FILE_BUNDLE_END -->)/;

if (!bundleBlock.test(html)) {
  throw new Error("Could not find #blizzard-file-bundle in index.html.");
}

writeFileSync(indexPath, html.replace(bundleBlock, (_match, start, end) => `${start}${bundle}\n${end}`));
rmSync(outPath, { force: true });
console.log("Updated index.html file:// bundle.");
