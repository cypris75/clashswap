// Applies db/schema.sql. Idempotent — run it as often as you like.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './load-env.mjs';
import { getPool } from '../src/lib/db.mjs';

loadEnv();

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sql = readFileSync(resolve(root, 'db/schema.sql'), 'utf8');

const pool = getPool();
try {
  await pool.query(sql);
  const { rows } = await pool.query(
    `select table_name, (select count(*) from information_schema.columns c
        where c.table_name = t.table_name and c.table_schema = 'public') as columns
     from information_schema.tables t
     where table_schema = 'public' and table_name in ('clans','members','member_cards')
     order by table_name`,
  );
  console.log('Schema applied. Tables:');
  for (const r of rows) console.log(`  ${r.table_name} (${r.columns} columns)`);
} finally {
  await pool.end();
}
