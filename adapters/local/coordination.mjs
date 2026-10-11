/** SQLite is the local authoritative backend; Cloudflare uses its own adapter. */
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { V1Error } from '../../core/v1/conventions.mjs';

const queues = new Map();
const context = new AsyncLocalStorage();

async function serialize(key, work) {
  if (context.getStore() === key) throw new V1Error('CONFLICT');
  const previous = queues.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise((done) => {
    release = done;
  });
  const tail = previous.then(() => gate);
  queues.set(key, tail);
  await previous;
  try {
    return await context.run(key, work);
  } finally {
    release();
    if (queues.get(key) === tail) queues.delete(key);
  }
}

export class SqliteCoordinationBackend {
  constructor({ filename, busy_timeout_ms }) {
    if (
      typeof filename !== 'string' ||
      !filename.trim() ||
      !Number.isSafeInteger(busy_timeout_ms) ||
      busy_timeout_ms < 0
    ) {
      throw new V1Error('INVALID_ARGUMENT');
    }
    this.key = filename === ':memory:' ? Symbol('database') : resolve(filename);
    this.pending = 0;
    this.closed = false;
    this.db = new DatabaseSync(filename);
    this.db.exec(
      `PRAGMA busy_timeout = ${busy_timeout_ms}; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;`,
    );
    this.db.exec('CREATE TABLE IF NOT EXISTS coordination_schema (version INTEGER NOT NULL)');
    const version = this.db.prepare('SELECT version FROM coordination_schema').get();
    if (!version) this.db.prepare('INSERT INTO coordination_schema (version) VALUES (?)').run(1);
    else if (version.version !== 1) {
      this.db.close();
      throw new V1Error('UNSUPPORTED_SCHEMA_VERSION');
    }
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS coordination (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (scope, key))',
    );
    this.read = this.db.prepare('SELECT value FROM coordination WHERE scope = ? AND key = ?');
    this.write = this.db.prepare(
      'INSERT INTO coordination (scope, key, value) VALUES (?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value',
    );
    this.remove = this.db.prepare('DELETE FROM coordination WHERE scope = ? AND key = ?');
  }

  async transaction(scope, callback) {
    if (this.closed) throw new V1Error('PROVIDER_UNAVAILABLE');
    this.pending += 1;
    try {
      return await serialize(this.key, async () => {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          const result = await callback({
            get: async (key) => {
              const row = this.read.get(scope, key);
              return row ? JSON.parse(row.value) : undefined;
            },
            put: async (key, value) => {
              this.write.run(scope, key, JSON.stringify(value));
            },
            delete: async (key) => {
              this.remove.run(scope, key);
            },
          });
          this.db.exec('COMMIT');
          return result;
        } catch (error) {
          this.db.exec('ROLLBACK');
          throw error;
        }
      });
    } finally {
      this.pending -= 1;
    }
  }

  close() {
    if (this.pending) throw new V1Error('CONFLICT');
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
