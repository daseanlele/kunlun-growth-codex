import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const packagePath = resolve("runtime/dsh/package.json");
const lockPath = resolve("runtime/dsh/upstream.lock.json");
const runtimePackage = JSON.parse(await readFile(packagePath, "utf8"));
const lock = JSON.parse(await readFile(lockPath, "utf8"));
const declared = runtimePackage.dependencies?.[lock.package];

if (!declared) throw new Error(`Missing ${lock.package} in ${packagePath}`);
if (declared !== lock.version) {
  throw new Error(`DSH version must be exact (${lock.version}), received ${declared}`);
}
if (!/^0\.1\.1-rc\.2$/.test(lock.version)) {
  throw new Error(`Unexpected DSH baseline: ${lock.version}`);
}
if (!/^[a-f0-9]{40}$/.test(lock.dist?.shasum ?? "")) {
  throw new Error("DSH npm shasum is missing or malformed");
}
if (!/^sha512-[A-Za-z0-9+/]+=*$/.test(lock.dist?.integrity ?? "")) {
  throw new Error("DSH npm integrity is missing or malformed");
}
if (!/^[a-f0-9]{40}$/.test(lock.source?.commit ?? "")) {
  throw new Error("DSH upstream commit is missing or malformed");
}
if (lock.source?.repository !== "https://github.com/deepseek-ai/deepseek-harness") {
  throw new Error("DSH upstream repository does not match the approved source");
}

console.log(`Verified ${lock.package}@${lock.version} (${lock.source.commit.slice(0, 12)})`);
