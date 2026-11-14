import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

export function openDatabase(filename = ':memory:') {
  const sqlite = new DatabaseSync(filename);
  sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  sqlite.exec('CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY)');

  const directory = new URL('../drizzle/', import.meta.url);
  const migrations = readdirSync(directory).filter(file => file.endsWith('.sql')).sort();
  for (const name of migrations) {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const applied = sqlite.prepare('SELECT 1 FROM local_migrations WHERE name = ?').get(name);
      if (!applied) {
        sqlite.exec(readFileSync(new URL(name, directory), 'utf8'));
        sqlite.prepare('INSERT INTO local_migrations (name) VALUES (?)').run(name);
      }
      sqlite.exec('COMMIT');
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  function prepare(sql, params = []) {
    const statement = sqlite.prepare(sql);
    const run = () => {
      const rows = statement.columns().length ? statement.all(...params) : null;
      const result = rows ? null : statement.run(...params);
      return { success: true, results: rows ?? [], meta: { changes: result?.changes ?? 0 } };
    };
    return {
      bind: (...values) => prepare(sql, values),
      first: async (column) => {
        const row = statement.get(...params);
        return column ? row?.[column] ?? null : row ?? null;
      },
      all: async () => ({ success: true, results: statement.all(...params) }),
      run: async () => run(),
      execute: run,
    };
  }

  return {
    prepare,
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(statement => statement.execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    close: () => sqlite.close(),
  };
}
