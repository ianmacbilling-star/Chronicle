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
      tier TEXT DEFAULT 'platinum',
      trial_started_at TIMESTAMP,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      subscription_status TEXT DEFAULT 'trialing',
      current_period_end TIMESTAMP,
      reset_token TEXT,
      reset_token_expires TIMESTAMP,
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
      canonical_prompt TEXT,
      canonical_prompt_at TIMESTAMP,
      canonical_reference_url TEXT,
      is_npc BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_by INTEGER NOT NULL,
      edited_at TIMESTAMP,
      edited_by INTEGER
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaign_assets (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'location',
      image_url TEXT,
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
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS tier TEXT DEFAULT 'platinum'",
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
    'ALTER TABLE moments ADD COLUMN IF NOT EXISTS emphasis TEXT',
    'ALTER TABLE characters ADD COLUMN IF NOT EXISTS canonical_prompt TEXT',
    'ALTER TABLE characters ADD COLUMN IF NOT EXISTS canonical_prompt_at TIMESTAMP',
    'ALTER TABLE characters ADD COLUMN IF NOT EXISTS is_npc BOOLEAN DEFAULT false',
    'ALTER TABLE characters ADD COLUMN IF NOT EXISTS canonical_reference_url TEXT',
    'ALTER TABLE session_characters ADD COLUMN IF NOT EXISTS reference_url TEXT',
    'ALTER TABLE session_characters ADD COLUMN IF NOT EXISTS change_flag BOOLEAN DEFAULT false',
    'ALTER TABLE session_characters ADD COLUMN IF NOT EXISTS change_detail TEXT',
    'ALTER TABLE session_characters ADD COLUMN IF NOT EXISTS change_moment_index INTEGER',
    "ALTER TABLE session_characters ADD COLUMN IF NOT EXISTS change_status TEXT DEFAULT 'none'",
    // Phase 3 multi-user — character claim state + session access status.
    // is_claimed = true means the character is fully owned (either a
    // normal DM-created PC/NPC, OR a stub that's been claimed via an
    // accepted invite). is_claimed = false means this character was
    // stubbed out as part of an invite and is awaiting acceptance.
    // Default is TRUE so every existing character (and every normal
    // DM-created character) is considered claimed.
    'ALTER TABLE characters ADD COLUMN IF NOT EXISTS is_claimed BOOLEAN DEFAULT true',
    'ALTER TABLE characters ADD COLUMN IF NOT EXISTS owner_user_id INTEGER',
    // sessions.player_access_status drives the Phase 3 lifecycle rule —
    // players can canonical-edit their character until ANY session in
    // the campaign is marked 'ready'. Using a TEXT field (not boolean)
    // so future states like 'archived' or 'locked' can be added without
    // a schema change. Default 'draft'. No UI to change this yet — that
    // comes in Deploy 3 of Phase 3 work.
    "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS player_access_status TEXT DEFAULT 'draft'",
    // Review tab — terse summaries of the opening and closing narrative.
    'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS narrative_intro_summary TEXT',
    'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS narrative_outro_summary TEXT',
    // Forgot-password flow. These were previously added to production by
    // hand and never captured as migrations, so a fresh DB (e.g. staging)
    // was missing them and forgot-password silently failed. Now migrated
    // properly so every environment gets them.
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMP',
    // Token system (Phase 1). last_active_campaign_id drives DM bonus
    // attribution: it's stamped on a player's image generations, then
    // looked up when they purchase tokens to credit the right DM.
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_campaign_id INTEGER',
    // image_generations gains fork_id (which fork the generation belongs
    // to; null = legacy/canonical) and model (which AI model produced it,
    // so per-model cost can be set from real data later).
    'ALTER TABLE image_generations ADD COLUMN IF NOT EXISTS fork_id INTEGER',
    'ALTER TABLE image_generations ADD COLUMN IF NOT EXISTS model TEXT',
    // Phase 4 Deploy 4.0 — content tables gain fork_id. Added nullable
    // here for existing DBs; backfilled and tightened to NOT NULL in
    // migrateForks() (called at the end of initPostgres).
    'ALTER TABLE moments ADD COLUMN IF NOT EXISTS fork_id INTEGER',
    'ALTER TABLE session_characters ADD COLUMN IF NOT EXISTS fork_id INTEGER',
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
      emphasis TEXT,
      image TEXT,
      panel_order INTEGER DEFAULT 0,
      fork_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_by INTEGER NOT NULL,
      edited_at TIMESTAMP,
      edited_by INTEGER
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS session_characters (
      id SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES sessions(id),
      character_id INTEGER NOT NULL REFERENCES characters(id),
      prompt TEXT,
      change_note TEXT,
      reference_url TEXT,
      change_flag BOOLEAN DEFAULT false,
      change_detail TEXT,
      change_moment_index INTEGER,
      change_status TEXT DEFAULT 'none',
      fork_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      edited_at TIMESTAMP,
      edited_by INTEGER
    )
  `);

  // One row per image generated. month_key ('YYYY-MM') lets us count
  // per-month without a reset job; all-time = COUNT(*) for the user.
  // source = what kind of image ('moment', 'character_reference', etc).
  // ref_id = the id of whatever it was for (moment id, character id...);
  // interpret it using source.
  // When Stripe lands, "this month" just counts from the billing anchor
  // instead of the calendar month — the rows never need to migrate.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS image_generations (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      source TEXT NOT NULL DEFAULT 'moment',
      ref_id INTEGER,
      month_key TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_imggen_user ON image_generations(user_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_imggen_user_month ON image_generations(user_id, month_key)');

  // Global app settings as simple key/value rows. Used for the
  // image-model selector and any future app-wide toggles.
  // 'id' column: the db.js wrapper appends RETURNING id to INSERTs.
  // 'setting_key' is the unique lookup column.
  // NOTE: this table PERSISTS across deploys — do NOT drop it, or
  // saved settings (like the chosen image model) get wiped.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      id SERIAL PRIMARY KEY,
      setting_key TEXT UNIQUE NOT NULL,
      value TEXT
    )
  `);

  // Seed the default image model to Nano Banana 2 on a fresh DB so the
  // Settings dropdown lands there out of the box. ON CONFLICT DO NOTHING
  // means an admin who has already chosen a different model is NEVER
  // overwritten on a redeploy — we only fill it in if it's missing.
  await pool.query(
    "INSERT INTO app_settings (setting_key, value) VALUES ('image_model', 'nano2') ON CONFLICT (setting_key) DO NOTHING"
  );

  // ============================================================
  // TOKEN SYSTEM (Phase 1 — internal ledger; Stripe wired later)
  // ============================================================
  // Design notes:
  // - Balance is DERIVED by summing token_ledger (single source of
  //   truth, always auditable). No cached balance column to drift.
  // - Two token types: 'utlt' (monthly grant, expires) and 'cot'
  //   (carry-over, never expires). Spend order: utlt first, then cot.
  // - Per-model token cost lives in app_settings as token_cost:<model>,
  //   defaulting to 1 if unset. 1:1 today; tunable later with no schema
  //   change as new models/pricing arrive.

  // Every credit and debit. Positive amount = credit, negative = debit.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS token_ledger (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      amount INTEGER NOT NULL,
      bucket TEXT NOT NULL,
      event_type TEXT NOT NULL,
      source TEXT,
      triggered_by_user_id INTEGER REFERENCES users(id),
      related_campaign_id INTEGER,
      related_purchase_id INTEGER,
      stripe_event_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_ledger_user ON token_ledger(user_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_ledger_user_bucket ON token_ledger(user_id, bucket)');

  // Record of every Stripe purchase. attributed_campaign_id is the
  // campaign that earns the DM the 10% bonus on this purchase.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS token_purchases (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      pack_tier TEXT,
      price_paid_cents INTEGER,
      tokens_granted INTEGER,
      stripe_session_id TEXT,
      stripe_payment_id TEXT,
      attributed_campaign_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_purchases_user ON token_purchases(user_id)');

  // Seed per-model token cost (1:1 today). DO NOTHING so an admin-tuned
  // value is never overwritten on redeploy.
  await pool.query(
    "INSERT INTO app_settings (setting_key, value) VALUES ('token_cost:nano2', '1') ON CONFLICT (setting_key) DO NOTHING"
  );
  await pool.query(
    "INSERT INTO app_settings (setting_key, value) VALUES ('token_cost:schnell', '1') ON CONFLICT (setting_key) DO NOTHING"
  );

  // ============================================================
  // CAMPAIGN MEMBERSHIP (Phase 1 — schema + backfill only;
  // authorization refactor happens in Phase 2)
  // ============================================================
  // Design notes:
  // - campaigns becomes a many-to-many with users via campaign_members.
  //   role is 'dm' or 'player'. UNIQUE(campaign_id, user_id) means one
  //   role per user per campaign.
  // - campaigns.user_id stays as-is during Phase 1 (every existing query
  //   reads it). Phase 2 refactors auth to read campaign_members instead.
  //   campaigns.created_by already exists as the immutable provenance
  //   column, so no rename is needed.
  // - campaign_invites carries a single-use token, a character_id binding
  //   (the PC the invitee will own), an optional email hint for the
  //   registration pre-fill / welcome flow, and a 7-day expiration.

  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaign_members (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      role TEXT NOT NULL,
      joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (campaign_id, user_id)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_cm_user ON campaign_members(user_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_cm_campaign ON campaign_members(campaign_id)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaign_invites (
      id SERIAL PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
      character_id INTEGER REFERENCES characters(id),
      role TEXT NOT NULL DEFAULT 'player',
      email_hint TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP NOT NULL,
      used_at TIMESTAMP,
      used_by INTEGER REFERENCES users(id)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_inv_token ON campaign_invites(token)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_inv_campaign ON campaign_invites(campaign_id)');

  // One-time backfill: every existing campaign's owner becomes a 'dm'
  // member. Idempotent thanks to the UNIQUE(campaign_id, user_id)
  // constraint + ON CONFLICT DO NOTHING — safe to re-run on every boot.
  // After Phase 2's auth refactor, campaign_members is the source of
  // truth, but Phase 1 just makes sure the data is there.
  await pool.query(`
    INSERT INTO campaign_members (campaign_id, user_id, role)
    SELECT id, user_id, 'dm' FROM campaigns
    ON CONFLICT (campaign_id, user_id) DO NOTHING
  `);

  // Phase 4 Deploy 4.0 — stand up session_forks, give every session a DM
  // fork, backfill content fork_id, then tighten to NOT NULL. Runs LAST
  // so all referenced tables (sessions, moments, session_characters,
  // campaign_members) and the campaign_members DM backfill exist first.
  await migrateForks(pool);

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
      canonical_prompt TEXT, canonical_prompt_at DATETIME, canonical_reference_url TEXT, is_npc INTEGER DEFAULT 0,
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
    CREATE TABLE IF NOT EXISTS campaign_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'location',
      image_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, created_by INTEGER NOT NULL,
      edited_at DATETIME, edited_by INTEGER
    );
    CREATE TABLE IF NOT EXISTS moments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL, title TEXT NOT NULL, description TEXT,
      type TEXT, prompt TEXT, emphasis TEXT, image TEXT, panel_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, created_by INTEGER NOT NULL,
      edited_at DATETIME, edited_by INTEGER
    );
    CREATE TABLE IF NOT EXISTS session_characters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL, character_id INTEGER NOT NULL,
      prompt TEXT, change_note TEXT,
      reference_url TEXT,
      change_flag INTEGER DEFAULT 0,
      change_detail TEXT,
      change_moment_index INTEGER,
      change_status TEXT DEFAULT 'none',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      edited_at DATETIME, edited_by INTEGER,
      UNIQUE (session_id, character_id)
    );
    CREATE TABLE IF NOT EXISTS image_generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'moment',
      ref_id INTEGER,
      month_key TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      setting_key TEXT UNIQUE NOT NULL,
      value TEXT
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
    'ALTER TABLE moments ADD COLUMN emphasis TEXT',
    'ALTER TABLE characters ADD COLUMN canonical_prompt TEXT',
    'ALTER TABLE characters ADD COLUMN canonical_prompt_at DATETIME',
    'ALTER TABLE characters ADD COLUMN is_npc INTEGER DEFAULT 0',
    'ALTER TABLE characters ADD COLUMN canonical_reference_url TEXT',
    'ALTER TABLE session_characters ADD COLUMN reference_url TEXT',
    'ALTER TABLE session_characters ADD COLUMN change_flag INTEGER DEFAULT 0',
    'ALTER TABLE session_characters ADD COLUMN change_detail TEXT',
    'ALTER TABLE session_characters ADD COLUMN change_moment_index INTEGER',
    "ALTER TABLE session_characters ADD COLUMN change_status TEXT DEFAULT 'none'",
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

// ============================================================
// PHASE 4 DEPLOY 4.0 — FORK MIGRATION + HELPER
// ============================================================
// migrateForks: idempotent. Safe to run on every boot.
//   1. CREATE session_forks (one fork per user per session; the DM's
//      canonical work is literally a role='dm' fork row).
//   2. Backfill a DM fork for every session, carrying its current
//      player_access_status + narrative.
//   3. Backfill moments/session_characters fork_id -> the DM fork.
//   4. GUARDED tighten to NOT NULL (only if zero orphan rows) + FK.
// NOT in the swallow-all alterations[] loop on purpose: order matters
// and a silent failure here must NOT pass unnoticed.
async function migrateForks(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS session_forks (
      id SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES sessions(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      role TEXT NOT NULL,
      player_access_status TEXT DEFAULT 'draft',
      narrative_intro TEXT,
      narrative_sections TEXT,
      narrative_outro TEXT,
      narrative_intro_summary TEXT,
      narrative_outro_summary TEXT,
      art_style_override TEXT,
      fork_notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      edited_at TIMESTAMP,
      edited_by INTEGER,
      UNIQUE (session_id, user_id)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_forks_session ON session_forks(session_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_forks_user ON session_forks(user_id)');

  // Backfill: one DM fork per session, owned by the campaign's DM.
  await pool.query(`
    INSERT INTO session_forks
      (session_id, user_id, role, player_access_status,
       narrative_intro, narrative_sections, narrative_outro,
       narrative_intro_summary, narrative_outro_summary, created_at)
    SELECT s.id, cm.user_id, 'dm', s.player_access_status,
           s.narrative_intro, s.narrative_sections, s.narrative_outro,
           s.narrative_intro_summary, s.narrative_outro_summary, NOW()
    FROM sessions s
    JOIN campaign_members cm
      ON cm.campaign_id = s.campaign_id AND cm.role = 'dm'
    ON CONFLICT (session_id, user_id) DO NOTHING
  `);

  // Backfill content fork_id -> the session's DM fork.
  await pool.query(`
    UPDATE moments m SET fork_id = f.id
    FROM session_forks f
    WHERE f.session_id = m.session_id AND f.role = 'dm' AND m.fork_id IS NULL
  `);
  await pool.query(`
    UPDATE session_characters sc SET fork_id = f.id
    FROM session_forks f
    WHERE f.session_id = sc.session_id AND f.role = 'dm' AND sc.fork_id IS NULL
  `);

  // GUARD: only tighten to NOT NULL if there are no orphan rows.
  const mNull = await pool.query('SELECT COUNT(*)::int AS c FROM moments WHERE fork_id IS NULL');
  const sNull = await pool.query('SELECT COUNT(*)::int AS c FROM session_characters WHERE fork_id IS NULL');
  if (mNull.rows[0].c === 0 && sNull.rows[0].c === 0) {
    await pool.query('ALTER TABLE moments ALTER COLUMN fork_id SET NOT NULL');
    await pool.query('ALTER TABLE session_characters ALTER COLUMN fork_id SET NOT NULL');
    // FK constraints — try/catch makes the re-run a no-op (PG has no
    // ADD CONSTRAINT IF NOT EXISTS for FKs).
    try { await pool.query('ALTER TABLE moments ADD CONSTRAINT moments_fork_fk FOREIGN KEY (fork_id) REFERENCES session_forks(id)'); } catch (e) {}
    try { await pool.query('ALTER TABLE session_characters ADD CONSTRAINT sc_fork_fk FOREIGN KEY (fork_id) REFERENCES session_forks(id)'); } catch (e) {}
    console.log('  Fork migration: fork_id NOT NULL + FK applied.');
  } else {
    console.error('  [migrateForks] ABORT NOT NULL — orphan rows. moments:', mNull.rows[0].c, 'session_characters:', sNull.rows[0].c);
  }

  // session_characters uniqueness is now per-FORK (each fork keeps its
  // own snapshot of a character), not per-session. Without this swap a
  // player version cannot copy the DM fork snapshots (same session_id +
  // character_id, different fork_id -> the old constraint blocks it).
  try { await pool.query('ALTER TABLE session_characters DROP CONSTRAINT IF EXISTS session_characters_session_id_character_id_key'); } catch (e) {}
  try { await pool.query('ALTER TABLE session_characters ADD CONSTRAINT session_characters_fork_character_key UNIQUE (fork_id, character_id)'); } catch (e) {}
}

// getOrCreateDmFork: returns the id of the session's DM fork, creating
// it if absent. Used by every route that INSERTs moments/session_characters
// (which now require fork_id) and by session creation / access-status.
async function getOrCreateDmFork(db, sessionId, dmUserId) {
  const existing = await db.prepare(
    "SELECT id FROM session_forks WHERE session_id = ? AND role = 'dm'"
  ).get(sessionId);
  if (existing) return existing.id;
  const r = await db.prepare(
    "INSERT INTO session_forks (session_id, user_id, role, created_at) VALUES (?, ?, 'dm', ?)"
  ).run(sessionId, dmUserId, new Date().toISOString());
  return r.lastInsertRowid;
}

// getDmForkId: id of the session's DM (canonical) fork, or null. Read-only.
async function getDmForkId(db, sessionId) {
  const f = await db.prepare("SELECT id FROM session_forks WHERE session_id = ? AND role = 'dm'").get(sessionId);
  return f ? f.id : null;
}

// getViewableForkId: resolves which fork a member may READ for a session.
//   - no requestedForkId  -> the DM fork (default = current behavior)
//   - the DM fork         -> always visible to any member
//   - your own fork       -> visible
//   - another player's    -> visible only if its status is 'ready'
// Returns the fork id to read, or null if not allowed (caller -> 403).
async function getViewableForkId(db, sessionId, userId, requestedForkId) {
  // Resolve the DM (canonical) fork once, with its owner + status.
  const dm = await db.prepare(
    "SELECT id, user_id, player_access_status FROM session_forks WHERE session_id = ? AND role = 'dm' LIMIT 1"
  ).get(sessionId);
  const isDM = dm && String(dm.user_id) === String(userId);
  // Has this caller made their OWN version of this session?
  const own = await db.prepare(
    "SELECT id FROM session_forks WHERE session_id = ? AND user_id = ? AND role = 'player'"
  ).get(sessionId, userId);
  // The DM (canonical) version is visible to the DM always; to a player only
  // once it is Ready, or once that player has made their own version. A DM
  // Draft session is otherwise hidden from players entirely.
  function dmVisible() {
    if (!dm) return false;
    if (isDM) return true;
    if (dm.player_access_status === 'ready') return true;
    if (own) return true;
    return false;
  }
  if (!requestedForkId) {
    return dmVisible() ? dm.id : null;
  }
  const f = await db.prepare(
    'SELECT id, user_id, role, player_access_status FROM session_forks WHERE id = ? AND session_id = ?'
  ).get(requestedForkId, sessionId);
  if (!f) return null;
  if (f.role === 'dm') return dmVisible() ? f.id : null;
  if (String(f.user_id) === String(userId)) return f.id;        // own version
  if (f.player_access_status === 'ready') return f.id;          // another player's Ready version
  return null;
}

module.exports = { getDb, isPostgres, getOrCreateDmFork, getDmForkId, getViewableForkId };
