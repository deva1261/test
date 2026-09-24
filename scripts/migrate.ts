import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';

// Resolves to <repo>/db/migrations both from scripts/ (tsx) and dist/scripts/ (compiled).
const MIGRATIONS_DIR = [path.resolve(__dirname, '../db/migrations'), path.resolve(__dirname, '../../db/migrations')];

async function findMigrationsDir(): Promise<string> {
  for (const dir of MIGRATIONS_DIR) {
    try {
      await readdir(dir);
      return dir;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`Migrations directory not found (looked in ${MIGRATIONS_DIR.join(', ')})`);
}

export async function migrate(databaseUrl: string): Promise<string[]> {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    // Serialise concurrent deploys running migrations at the same time.
    await client.query('SELECT pg_advisory_lock(727274)');

    const dir = await findMigrationsDir();
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name));

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    await client.query('SELECT pg_advisory_unlock(727274)');
  } finally {
    client.release();
    await pool.end();
  }
  return applied;
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  migrate(url)
    .then((applied) => {
      console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
