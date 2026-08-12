import pg from 'pg';

// Supabase hands out counts as strings by default (bigint/numeric safety);
// smallint and int are safe to read as JS numbers here.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

let pool;

/**
 * Lazily created connection pool, reused across warm serverless invocations.
 * DATABASE_URL never leaves the server — the browser only ever sees /api/*.
 */
export function getPool() {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  }

  pool = new pg.Pool({
    connectionString,
    // Supabase terminates TLS with a certificate chain Node does not ship;
    // the connection is still encrypted.
    ssl: { rejectUnauthorized: false },
    max: Number(process.env.PGPOOL_MAX || 3),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    // The transaction pooler (port 6543) does not support named prepared
    // statements; node-postgres only uses them when you ask for them.
    application_name: 'clashswap',
  });

  pool.on('error', (err) => console.error('[db] idle client error', err.message));
  return pool;
}

export async function query(text, params) {
  return getPool().query(text, params);
}

export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
