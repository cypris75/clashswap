import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Loads .env into process.env for local scripts. Netlify injects its own. */
export function loadEnv(file = '.env') {
  const path = resolve(root, file);
  if (!existsSync(path)) return false;
  process.loadEnvFile(path);
  return true;
}
