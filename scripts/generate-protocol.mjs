import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const platformNames = { win32: "win32", darwin: "darwin", linux: "linux" };
const archNames = { x64: "x64", arm64: "arm64" };
const triples = {
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
};
const platform = platformNames[process.platform];
const arch = archNames[process.arch];
const key = `${platform}-${arch}`;
const triple = triples[key];
if (!platform || !arch || !triple) throw new Error(`Unsupported platform: ${process.platform}/${process.arch}`);

const executable = process.platform === "win32" ? "codex.exe" : "codex";
const binary = resolve(`node_modules/@openai/codex-${key}/vendor/${triple}/bin/${executable}`);
if (!existsSync(binary)) throw new Error(`Codex runtime is missing: ${binary}`);

const types = resolve("src/generated/app-server");
const schemas = resolve("protocol/schema");
await mkdir(types, { recursive: true });
await mkdir(schemas, { recursive: true });

for (const [command, output] of [["generate-ts", types], ["generate-json-schema", schemas]]) {
  const result = spawnSync(binary, ["app-server", command, "--out", output], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Protocol generation failed: ${command}`);
}

console.log(`Generated App Server protocol from ${join("@openai", `codex-${key}`)}.`);
