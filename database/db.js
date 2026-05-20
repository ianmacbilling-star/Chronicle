const path = require('path');
const fs = require('fs');

let db;
let usePostgres = false;

// ============================================================
// POSTGRES ADAPTER
// Wraps pg to look like better-sqlite3 (synchronous interface)
// ============================================================
class PostgresAdapter {
  constructor(client) {
    this.client = client;
  }

  prepare(sql) {
    const client = this.client;
    // Convert SQLite ? placeholders to PostgreSQL $1, $2...
    function toPostgres(sql, params) {
      let i = 0;
      return sql.replace(/\?/g, () => '$' + (++i));
    }

    return {
      run: function(...args) {
        const params = args.flat();
        const pgSql = toPostgres(sql, params);
        // Fire and forget sync-style — we use a sync wrapper
        const result = runSync(client, pgSql, params);
        return { lastInsertRowid: result ? result.lastInsertRowid : null, changes: result ? result.changes : 0 };
      },
      get: function(...args) {
        const params = args.flat();
        const pgSql = toPostgres(sql, params);
        return runSyncGet(client, pgSql, params);
      },
      all: function(...args) {
        const params = args.flat();
        const pgSql = toPostgres(sql, params);
        return runSyncAll(client, pgSql, params);
      }
    };
  }

  exec(sql) {
    // For migrations - run synchronously
    runSyncExec(this.client, sql);
  }
}

// Synchronous wrappers using Atomics/SharedArrayBuffer trick
// Since pg is async but better-sqlite3 is sync, we use a child process approach
// Actually - we'll use a different strategy: pre-run all migrations async at startup
// and use sync-over-async for queries via node's --experimental-vm-modules
// 
// SIMPLER APPROACH: Use 'pg-sync' or convert routes to async
// We'll convert the database layer to return promises and update routes

// ============================================================
// BETTER APPROACH: Async DB wrapper
// Update all routes to use await
// ============================================================

class AsyncDB {
  constructor(pool) {
    this.pool = pool;
  }

  prepare(sql) {
    const pool = this.pool;

    function toPostgres(sql) {
      let i = 0;
      return sql.replace(/\?/g, () => '$' + (++i));
    }

    const pgSql = toPostgres(sql);

    return {
      // For INSERT - returns lastInsertRowid
      run: async function(...args) {
        const params = args.flat();
        // Add RETURNING id for INSERT statements
        let finalSql = pgSql;
        if (pgSql.trim().toUpperCase().startsWith('INSERT')) {
          finalSql = pgSql + ' RETURNING id';
        }
        const result = await pool.query(finalSql, params);
        return {
          lastInsertRowid: result.rows[0] ? result.rows[0].id : null,
          changes: result.rowCount
        };
      },
      get: async function(...args) {
        const params = args.flat();
        const result = await pool.query(pgSql, params);
        return result.rows[0] || null;
      },
      all: async function(...args) {
        const params = args.flat();
        const result = await pool.query(pgSql, params);
        return result.rows;
      }
    };
  }

  async exec(sql) {
    await this.pool.query(sql);
  }
}

// ============================================================
// INITIALIZATION
// ============================================================

async function initPostgres() {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  // Test connection
  await pool.query('SELECT 1');
  console.log('  PostgreSQL connected!');

  const db = new AsyncDB(pool);

  // Run migrations
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      api_key TEXT,
      fal_key TEXT,
      tier TEXT DEFAULT 'copper',
      trial_started_at TIMESTAMP,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      subscription_status TEXT DEFAULT 'trialing',
      current_period_end TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      edited_at TIMESTAMP,
      edited_by INTEGER
    )
  `);

  // Tier/billing migrations
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tier_events (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      event_type TEXT NOT NULL,
      from_tier TEXT,
      to_tier TEXT,
      stripe_event_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      description TEXT,
      art_style TEXT,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_by INTEGER NOT NULL,
      edited_at TIMESTAMP,
      edited_by INTEGER
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS characters (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
      name TEXT NOT NULL,
      player_name TEXT,
      cls TEXT,
      description TEXT,
      image TEXT,
      image_portrait TEXT,
      image_fullbody TEXT,
      image_action TEXT,
      image_other TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_by INTEGER NOT NULL,
      edited_at TIMESTAMP,
      edited_by INTEGER
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
      name TEXT NOT NULL,
      session_date DATE NOT NULL,
      transcript TEXT,
      session_notes TEXT,
      art_style TEXT,
      layout_style TEXT,
      narrative_intro TEXT,
      narrative_sections TEXT,
      narrative_outro TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_by INTEGER NOT NULL,
      edited_at TIMESTAMP,
      edited_by INTEGER
    )
  `);

  // ALTER TABLE migrations for existing databases
  const alterations = [
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS tier TEXT DEFAULT 'copper'",
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMP',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT',
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'trialing'",
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMP',
    'ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true',
    'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS art_style TEXT',
    'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS layout_style TEXT',
    'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS session_notes TEXT',
    'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS narrative_intro TEXT',
    'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS narrative_sections TEXT',
    'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS narrative_outro TEXT',
    'ALTER TABLE characters ADD COLUMN IF NOT EXISTS player_name TEXT',
    'ALTER TABLE characters ADD COLUMN IF NOT EXISTS image_portrait TEXT',
    'ALTER TABLE characters ADD COLUMN IF NOT EXISTS image_fullbody TEXT',
    'ALTER TABLE characters ADD COLUMN IF NOT EXISTS image_action TEXT',
    'ALTER TABLE characters ADD COLUMN IF NOT EXISTS image_other TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS fal_key TEXT',
  ];
  for (const sql of alterations) {
    try { await pool.query(sql); } catch(e) {}
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS moments (
      id SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES sessions(id),
      title TEXT NOT NULL,
      description TEXT,
      type TEXT,
      prompt TEXT,
      image TEXT,
      panel_order INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_by INTEGER NOT NULL,
      edited_at TIMESTAMP,
      edited_by INTEGER
    )
  `);

  console.log('  PostgreSQL schema ready!');
  return db;
}

function initSQLite() {
  const Database = require('better-sqlite3');
  const DATA_DIR = path.join(__dirname, '../data');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const sqlite = new Database(path.join(DATA_DIR, 'chronicle.db'));
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  // Run schema
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password TEXT NOT NULL,
      api_key TEXT, fal_key TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, edited_at DATETIME, edited_by INTEGER
    );
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL, name TEXT NOT NULL, description TEXT, art_style TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, created_by INTEGER NOT NULL,
      edited_at DATETIME, edited_by INTEGER
    );
    CREATE TABLE IF NOT EXISTS characters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL, name TEXT NOT NULL, player_name TEXT,
      cls TEXT, description TEXT, image TEXT,
      image_portrait TEXT, image_fullbody TEXT, image_action TEXT, image_other TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, created_by INTEGER NOT NULL,
      edited_at DATETIME, edited_by INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL, name TEXT NOT NULL, session_date DATE NOT NULL,
      transcript TEXT, session_notes TEXT, art_style TEXT,
      narrative_intro TEXT, narrative_sections TEXT, narrative_outro TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, created_by INTEGER NOT NULL,
      edited_at DATETIME, edited_by INTEGER
    );
    CREATE TABLE IF NOT EXISTS moments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL, title TEXT NOT NULL, description TEXT,
      type TEXT, prompt TEXT, image TEXT, panel_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, created_by INTEGER NOT NULL,
      edited_at DATETIME, edited_by INTEGER
    );
  `);

  // SQLite migrations for existing databases
  const migrations = [
    'ALTER TABLE characters ADD COLUMN player_name TEXT',
    'ALTER TABLE characters ADD COLUMN image_portrait TEXT',
    'ALTER TABLE characters ADD COLUMN image_fullbody TEXT',
    'ALTER TABLE characters ADD COLUMN image_action TEXT',
    'ALTER TABLE characters ADD COLUMN image_other TEXT',
    'ALTER TABLE sessions ADD COLUMN session_notes TEXT',
    'ALTER TABLE sessions ADD COLUMN art_style TEXT',
    'ALTER TABLE sessions ADD COLUMN narrative_intro TEXT',
    'ALTER TABLE sessions ADD COLUMN narrative_sections TEXT',
    'ALTER TABLE sessions ADD COLUMN narrative_outro TEXT',
    'ALTER TABLE users ADD COLUMN api_key TEXT',
    'ALTER TABLE users ADD COLUMN fal_key TEXT',
  ];
  migrations.forEach(function(m) { try { sqlite.exec(m); } catch(e) {} });

  console.log('  SQLite connected!');

  // Wrap to match async interface (returns resolved promises)
  return {
    prepare: function(sql) {
      const stmt = sqlite.prepare(sql);
      return {
        run: function(...args) { return Promise.resolve(stmt.run(...args)); },
        get: function(...args) { return Promise.resolve(stmt.get(...args)); },
        all: function(...args) { return Promise.resolve(stmt.all(...args)); }
      };
    },
    exec: function(sql) { sqlite.exec(sql); return Promise.resolve(); }
  };
}

// ============================================================
// EXPORTED FUNCTIONS
// ============================================================

let _db = null;
let _initialized = false;

async function getDb() {
  if (_db) return _db;
  if (process.env.DATABASE_URL) {
    _db = await initPostgres();
    usePostgres = true;
  } else {
    _db = initSQLite();
  }
  _initialized = true;
  return _db;
}

function isPostgres() { return usePostgres; }

module.exports = { getDb, isPostgres };
