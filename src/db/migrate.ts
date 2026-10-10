import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";

type MigrationFile = {
  id: string;
  filename: string;
  sql: string;
  checksum: string;
};

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to run database migrations");
}

const migrationsDirectory = path.resolve(
  process.env.MIGRATIONS_DIR ?? path.join(process.cwd(), "migrations"),
);

const checksum = (contents: string) => createHash("sha256").update(contents).digest("hex");

const readMigrations = async (): Promise<MigrationFile[]> => {
  const filenames = (await readdir(migrationsDirectory))
    .filter((filename) => /^\d+_[a-z0-9_]+\.sql$/i.test(filename))
    .sort((left, right) => {
      const leftId = Number(/^(\d+)_/.exec(left)?.[1]);
      const rightId = Number(/^(\d+)_/.exec(right)?.[1]);
      return leftId - rightId;
    });

  if (filenames.length === 0) {
    throw new Error(`No SQL migrations found in ${migrationsDirectory}`);
  }

  const migrations = await Promise.all(
    filenames.map(async (filename) => {
      const match = /^(\d+)_/.exec(filename);
      if (!match) {
        throw new Error(`Invalid migration filename: ${filename}`);
      }
      const sql = await readFile(path.join(migrationsDirectory, filename), "utf8");
      return {
        id: match[1],
        filename,
        sql,
        checksum: checksum(sql),
      } satisfies MigrationFile;
    }),
  );

  const ids = new Set<string>();
  for (const migration of migrations) {
    if (ids.has(migration.id)) {
      throw new Error(`Duplicate migration id: ${migration.id}`);
    }
    ids.add(migration.id);
  }
  return migrations;
};

const migrate = async () => {
  const migrations = await readMigrations();
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });

  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id text PRIMARY KEY,
          checksum text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      let applied = 0;
      for (const migration of migrations) {
        const result = await client.query<{ checksum: string }>(
          "SELECT checksum FROM schema_migrations WHERE id = $1",
          [migration.id],
        );
        const existing = result.rows[0];

        if (existing) {
          if (existing.checksum !== migration.checksum) {
            throw new Error(
              `Migration ${migration.filename} was changed after it was applied; create a new migration instead`,
            );
          }
          continue;
        }

        console.log(`Applying migration ${migration.filename}`);
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)",
          [migration.id, migration.checksum],
        );
        applied += 1;
      }

      await client.query("COMMIT");
      console.log(`Database migrations complete: ${applied} applied, ${migrations.length - applied} already applied`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
};

try {
  await migrate();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
