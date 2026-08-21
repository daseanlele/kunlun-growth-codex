import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('apps/harmony');
const required = [
  'AppScope/app.json5',
  'build-profile.json5',
  'entry/src/main/module.json5',
  'entry/src/main/ets/entryability/EntryAbility.ets',
  'entry/src/main/ets/pages/Index.ets',
  'entry/src/main/ets/service/AgentGateway.ets',
  'entry/src/main/resources/base/profile/main_pages.json'
];

for (const file of required) {
  if (!existsSync(resolve(root, file))) throw new Error(`HarmonyOS file missing: ${file}`);
}
const app = readFileSync(resolve(root, 'AppScope/app.json5'), 'utf8');
const moduleConfig = readFileSync(resolve(root, 'entry/src/main/module.json5'), 'utf8');
if (!app.includes('cn.kunlungrowth.codex')) throw new Error('HarmonyOS bundleName is incorrect');
for (const device of ['phone', 'tablet', '2in1']) {
  if (!moduleConfig.includes(`\"${device}\"`)) throw new Error(`HarmonyOS device type missing: ${device}`);
}
console.log(`HarmonyOS structure check passed (${required.length} required files).`);
