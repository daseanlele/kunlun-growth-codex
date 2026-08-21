import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const outputDirectory = resolve("dist");
const indexPath = resolve(outputDirectory, "index.html");
let html = await readFile(indexPath, "utf8");

const scriptMatch = html.match(/<script type="module" crossorigin src="([^\"]+)"><\/script>/);
const styleMatch = html.match(/<link rel="stylesheet" crossorigin href="([^\"]+)">/);
if (!scriptMatch || !styleMatch) throw new Error("Unable to locate Vite assets for offline preview");

const assetPath = (reference) => resolve(outputDirectory, reference.replace(/^\.\//, ""));
const javascript = (await readFile(assetPath(scriptMatch[1]), "utf8")).replace(/<\/script/gi, "<\\/script");
const css = await readFile(assetPath(styleMatch[1]), "utf8");

html = html
  .replace('<script src="./file-preview.js"></script>', "")
  .replace(scriptMatch[0], `<script type="module">${javascript}</script>`)
  .replace(styleMatch[0], `<style>${css}</style>`);

await writeFile(resolve(outputDirectory, "offline.html"), html, "utf8");
console.log("Generated dist/offline.html for direct file preview.");
