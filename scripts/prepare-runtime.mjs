import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

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
if (!platform || !arch) throw new Error(`Unsupported runtime platform: ${process.platform}/${process.arch}`);

const key = `${platform}-${arch}`;
const triple = triples[key];
const packageRoot = resolve(`node_modules/@openai/codex-${key}`);
const vendor = join(packageRoot, "vendor", triple);
const destination = resolve("src-tauri/resources/runtime");

if (!existsSync(vendor)) {
  throw new Error(`Codex runtime package is missing: ${vendor}`);
}

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(vendor, destination, { recursive: true });

console.log(`Prepared Codex runtime ${key} from ${vendor}`);

