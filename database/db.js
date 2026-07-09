const path = require('path');
const fs = require('fs');

let db;
let usePostgres = false;

// ============================================================
// POSTGRES ADAPTER
// Wraps pg with a synchronous-looking prepared-statement interface
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
// pg is async; this adapter presents a synchronous-style query interface
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
      render_thinking INTEGER DEFAULT 0,
      pen_name TEXT,
      tier TEXT DEFAULT 'platinum',
      trial_started_at TIMESTAMP,
      last_active_at TIMESTAMP,
      lone_since TIMESTAMP,
      last_purchase_at TIMESTAMP,
      idle_warned_at TIMESTAMP,
      tombstoned_at TIMESTAMP,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      subscription_status TEXT DEFAULT 'trialing',
      current_period_end TIMESTAMP,
      cancel_at_period_end BOOLEAN DEFAULT false,
      card_brand TEXT,
      card_last4 TEXT,
      card_exp TEXT,
      reset_token TEXT,
      reset_token_expires TIMESTAMP,
      date_of_birth DATE,
      tos_accepted_version TEXT,
      tos_accepted_at TIMESTAMP,
      upload_terms_accepted BOOLEAN DEFAULT false,
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
      allow_player_novel_access BOOLEAN DEFAULT false,
      allow_member_assets BOOLEAN DEFAULT false,
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
      novel_include BOOLEAN DEFAULT true,
      narrative_intro TEXT,
      narrative_sections TEXT,
      narrative_outro TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_by INTEGER NOT NULL,
      edited_at TIMESTAMP,
      edited_by INTEGER
    )
  `);

  // Async image generation jobs (fal queue + webhook delivery). One row per
  // generation request; the webhook fills image_url + flips status to done.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS image_jobs (
      id SERIAL PRIMARY KEY,
      request_id TEXT,
      user_id INTEGER,
      campaign_id INTEGER,
      moment_id INTEGER,
      fork_id INTEGER,
      character_id INTEGER,
      kind TEXT DEFAULT 'moment',
      status TEXT DEFAULT 'queued',
      model TEXT,
      style TEXT,
      cost INTEGER DEFAULT 0,
      prev_image TEXT,
      image_url TEXT,
      error TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_image_jobs_request ON image_jobs(request_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_image_jobs_user ON image_jobs(user_id, status)');

  // Async narrative generation jobs (submit -> poll). One row per generate
  // request; a background task fills result + flips status done/error, so a
  // long Claude call can't hit the gateway timeout on a synchronous request.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS narrative_jobs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      campaign_id INTEGER,
      session_id INTEGER,
      fork_id INTEGER,
      status TEXT DEFAULT 'pending',
      result TEXT,
      error TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_narrative_jobs_user ON narrative_jobs(user_id, status)');

  // Custom Art Styles (Platinum builder): account-wide, owned by the user. A
  // generated/edited STYLE: paragraph that rides system_prompt like any preset.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS custom_art_styles (
      id SERIAL PRIMARY KEY,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      style_prompt TEXT NOT NULL,
      is_fade INTEGER DEFAULT 0,
      sample_urls TEXT,
      model_hint TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_custom_art_styles_owner ON custom_art_styles(owner_id)');

  // Debug Mode (per-user, opt-in) capture log. Bounded per user by the retention
  // prune in routes/debug.js (30 days / 5000 rows). detail holds a JSON blob so an
  // entry is both human-readable and machine-parseable.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS debug_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      level TEXT,
      source TEXT,
      page TEXT,
      fn TEXT,
      message TEXT,
      detail TEXT
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_debug_logs_user ON debug_logs(user_id, id)');

  // ALTER TABLE migrations for existing databases
  const alterations = [
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS debug_mode BOOLEAN DEFAULT false',
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS vocab TEXT DEFAULT 'ttrpg'",
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_promo BOOLEAN DEFAULT true',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_promo_code TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_features BOOLEAN DEFAULT true',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_activity BOOLEAN DEFAULT true',
    'ALTER TABLE image_jobs ADD COLUMN IF NOT EXISTS character_id INTEGER',
    'ALTER TABLE image_jobs ADD COLUMN IF NOT EXISTS asset_id INTEGER',
    'ALTER TABLE campaign_assets ADD COLUMN IF NOT EXISTS description TEXT',
    'ALTER TABLE campaign_assets ADD COLUMN IF NOT EXISTS revert_image_url TEXT',
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS tier TEXT DEFAULT 'platinum'",
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMP',
    // Account-lifecycle idle clock (ACCOUNT_LIFECYCLE_SPEC Phase 0). Backfill
    // existing rows to now() ONCE so the clock starts today, never retroactively;
    // new rows are stamped at registration/login so the WHERE no-ops thereafter.
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP',
    'UPDATE users SET last_active_at = CURRENT_TIMESTAMP WHERE last_active_at IS NULL',
    // Account-lifecycle Phase 2: lone-copper idle clock + warn idempotency.
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS lone_since TIMESTAMP',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS last_purchase_at TIMESTAMP',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS idle_warned_at TIMESTAMP',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS tombstoned_at TIMESTAMP',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT',
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'trialing'",
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMP',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN DEFAULT false',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS card_brand TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS card_last4 TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS card_exp TEXT',
    'ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true',
    'ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS cover_image_url TEXT',
    'ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS back_cover_image_url TEXT',
    'ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS campaign_image_url TEXT',
    'ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS title_image_url TEXT',
    'ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS allow_player_novel_access BOOLEAN DEFAULT false',
    'ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS allow_member_assets BOOLEAN DEFAULT false',
    'ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS lore TEXT',
    'ALTER TABLE custom_art_styles ADD COLUMN IF NOT EXISTS preview_url TEXT',
    // DM handoff: marks a campaign whose Story Master role was transferred.
    // inherited_at present => exempt from per-tier campaign limits later; the
    // from-user records provenance for attribution / tombstone context.
    'ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS inherited_at TIMESTAMP',
    'ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS inherited_from_user_id INTEGER',
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
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS render_thinking INTEGER DEFAULT 0',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS pen_name TEXT',
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS tour_progress JSONB DEFAULT '{}'::jsonb",
    'ALTER TABLE moments ADD COLUMN IF NOT EXISTS emphasis TEXT',
    'ALTER TABLE moments ADD COLUMN IF NOT EXISTS img_w INTEGER',
    'ALTER TABLE moments ADD COLUMN IF NOT EXISTS img_h INTEGER',
    'ALTER TABLE moments ADD COLUMN IF NOT EXISTS revert_image TEXT',
    'ALTER TABLE moments ADD COLUMN IF NOT EXISTS revert_img_w INTEGER',
    'ALTER TABLE moments ADD COLUMN IF NOT EXISTS revert_img_h INTEGER',
    'ALTER TABLE moments ADD COLUMN IF NOT EXISTS layout_meta TEXT',
    'ALTER TABLE characters ADD COLUMN IF NOT EXISTS canonical_prompt TEXT',
    'ALTER TABLE characters ADD COLUMN IF NOT EXISTS canonical_prompt_at TIMESTAMP',
    'ALTER TABLE characters ADD COLUMN IF NOT EXISTS is_npc BOOLEAN DEFAULT false',
    'ALTER TABLE characters ADD COLUMN IF NOT EXISTS canonical_reference_url TEXT',
    'ALTER TABLE characters ADD COLUMN IF NOT EXISTS revert_reference_url TEXT',
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
    // Session establishing image -- an auto-generated wide "title card" shot of
    // the session setting, created during Generate Story and controllable like a
    // panel image (edit prompt / regenerate / retouch / replace / lock / archive).
    // Mirrors the moments image columns. Used as the title image on a single-session
    // publish and as an interior session divider on a multi-session publish.
    'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS establishing_image TEXT',
    'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS establishing_prompt TEXT',
    'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS establishing_img_w INTEGER',
    'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS establishing_img_h INTEGER',
    "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS establishing_shape TEXT DEFAULT 'wide'",
    'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS establishing_style TEXT',
    'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS establishing_locked INTEGER DEFAULT 0',
    'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS establishing_layout_meta TEXT',
    // Optional short session description (blurb under the session title),
    // set at create time or edited inline; mirrors the campaign description.
    'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS description TEXT',
    // image_jobs.session_id routes a kind='session_establishing' generation back
    // to its session (the table already keys moment/character jobs by their ids).
    'ALTER TABLE image_jobs ADD COLUMN IF NOT EXISTS session_id INTEGER',
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
    // Account lifecycle (suspend -> 6-month hold -> anonymized delete).
    // status: 'active' | 'suspended' | 'deleted' (tombstone). suspended_at
    // starts the retention clock the future sweep job will act on.
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'",
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMP',
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
    // Image locking — a locked storyboard moment is skipped by generate-all
    // and blocks Generate Story (re-extract) for its version. Per-fork.
    'ALTER TABLE moments ADD COLUMN IF NOT EXISTS locked INTEGER DEFAULT 0',
    'ALTER TABLE moments ADD COLUMN IF NOT EXISTS style TEXT',
    // Pass 2 — explicit per-panel casting. false (default) = name-match
    // inference (legacy behavior); flipped true the first time a user edits a
    // panel's cast, after which moment_characters/moment_assets are authoritative.
    'ALTER TABLE moments ADD COLUMN IF NOT EXISTS cast_explicit BOOLEAN DEFAULT false',
    "ALTER TABLE moments ADD COLUMN IF NOT EXISTS shape TEXT DEFAULT 'standard'",
    // Approach B: the title image is just the first moment (kind='establishing'),
    // created wide + high-prominence so it renders as a title/chapter image.
    "ALTER TABLE moments ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'normal'",
    'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS novel_include BOOLEAN DEFAULT true',
    // Account terms + age. Collected at sign-up: DOB (age verification),
    // which Terms version they accepted + when, and the upload/IP attestation.
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth DATE',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS tos_accepted_version TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS tos_accepted_at TIMESTAMP',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS upload_terms_accepted BOOLEAN DEFAULT false',
  ];
  for (const sql of alterations) {
    try { await pool.query(sql); } catch(e) {}
  }

  // Pen name: case-insensitive unique across users, ignoring blanks/NULLs.
  // Public-facing author identity for the Public Library.
  try { await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_pen_name ON users (lower(pen_name)) WHERE pen_name IS NOT NULL AND pen_name <> ''"); } catch(e) {}

  await pool.query(`
    CREATE TABLE IF NOT EXISTS moments (
      id SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES sessions(id),
      title TEXT NOT NULL,
      description TEXT,
      type TEXT,
      prompt TEXT,
      emphasis TEXT,
      shape TEXT DEFAULT 'standard',
      image TEXT,
      img_w INTEGER,
      img_h INTEGER,
      layout_meta TEXT,
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

  // Account-lifecycle thresholds (days), admin-tunable. 3 months to suspend,
  // 6 months suspended -> deleted. ON CONFLICT keeps any admin-saved values.
  await pool.query(
    "INSERT INTO app_settings (setting_key, value) VALUES ('lifecycle_idle_days', '90') ON CONFLICT (setting_key) DO NOTHING"
  );
  await pool.query(
    "INSERT INTO app_settings (setting_key, value) VALUES ('lifecycle_purge_days', '180') ON CONFLICT (setting_key) DO NOTHING"
  );
  // Grace window (days) between the idle warning and suspension.
  await pool.query(
    "INSERT INTO app_settings (setting_key, value) VALUES ('lifecycle_warn_grace_days', '14') ON CONFLICT (setting_key) DO NOTHING"
  );
  // Purge-warning lead times (days before deletion), comma-separated.
  await pool.query(
    "INSERT INTO app_settings (setting_key, value) VALUES ('lifecycle_purge_warn_days', '30,7') ON CONFLICT (setting_key) DO NOTHING"
  );

  // Global Max Pages Per Print limit (applies to ALL layouts). Default 250;
  // admin-editable via the dashboard. ON CONFLICT preserves any saved value.
  await pool.query(
    "INSERT INTO app_settings (setting_key, value) VALUES ('max_pages_per_print', '250') ON CONFLICT (setting_key) DO NOTHING"
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
  // Analytics record of every generation (charged OR free) -- parallel to, and
  // independent of, token_ledger. tokens_redeemed = tokens charged (0 for free
  // actions like an un-priced Story/Narrative). quantity + unit + model give the
  // cost basis so the exact $ cost can be derived later regardless of vendor repricing.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS generation_events (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      event_type TEXT NOT NULL,
      tokens_redeemed INTEGER NOT NULL DEFAULT 0,
      quantity INTEGER,
      unit TEXT,
      model TEXT,
      related_campaign_id INTEGER,
      related_session_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_genevents_type ON generation_events(event_type)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_genevents_created ON generation_events(created_at)');
  // Promo codes (Stage 1): app-side catalog of promo/ad codes. Rides on top of
  // Stripe-native discounts (purchases) and ad-link ?promo capture (signups). The
  // action (token_grant / percent_off / amount_off + value) drives what happens;
  // instructions JSONB is reserved for future richer directives. token_grant is the
  // only action executed app-side for now.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS promo_codes (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      label TEXT,
      action_type TEXT NOT NULL DEFAULT 'token_grant',
      action_value INTEGER NOT NULL DEFAULT 0,
      instructions JSONB,
      expires_at TIMESTAMP,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      redeemed_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_promo_codes_code ON promo_codes(code)');
  // Redemptions: one row per use (purchase or signup) -- the attribution/metrics spine.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS promo_redemptions (
      id SERIAL PRIMARY KEY,
      promo_code_id INTEGER REFERENCES promo_codes(id),
      code TEXT,
      user_id INTEGER REFERENCES users(id),
      context TEXT,
      applied JSONB,
      stripe_session_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_promo_redemptions_code ON promo_redemptions(promo_code_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_promo_redemptions_user ON promo_redemptions(user_id)');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_redemptions_dedupe ON promo_redemptions(user_id, stripe_session_id) WHERE stripe_session_id IS NOT NULL');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS metric_snapshots (
      id SERIAL PRIMARY KEY,
      week_start DATE NOT NULL,
      metric TEXT NOT NULL,
      tier TEXT NOT NULL DEFAULT '',
      value BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_metric_snapshots_uniq ON metric_snapshots (week_start, metric, tier)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_metric_snapshots_metric ON metric_snapshots (metric, week_start)');

  // Lifecycle email ledger: one row per (user, email_type) when a scheduled
  // lifecycle email is sent (trial nudges). The UNIQUE constraint makes the
  // daily scheduler pass idempotent -- nobody is emailed the same milestone
  // twice, even across restarts.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lifecycle_emails (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      email_type TEXT NOT NULL,
      sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, email_type)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_lifecycle_user ON lifecycle_emails(user_id)');

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
      member_prefs TEXT,
      joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (campaign_id, user_id)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_cm_user ON campaign_members(user_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_cm_campaign ON campaign_members(campaign_id)');
  // Per-member saved Art Style / Narrative Style / Layout (co) bundle, as a
  // JSON string. Absent => the member has no saved prefs (UI falls back to
  // campaign/session defaults). Guarded ALTER so it is safe to re-run.
  await pool.query('ALTER TABLE campaign_members ADD COLUMN IF NOT EXISTS member_prefs TEXT');

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

  // Campaign Archives — saved-off images that survive regen/re-extract.
  // After migrateForks so session_forks + moments exist for the FKs.
  await migrateArchives(pool);

  // Pass 2 — explicit per-panel casting tables. After moments exist.
  await migrateCasting(pool);

  // Scaling hardening — performance indexes on hot-path FK / filter
  // columns and the releaseImage() URL lookups. Runs LAST so every
  // referenced column already exists.
  await migratePerfIndexes(pool);

  console.log('  PostgreSQL schema ready!');
  return db;
}

// SQLite support removed - this app is Postgres-only (see getDb()).

// ============================================================
// EXPORTED FUNCTIONS
// ============================================================

let _db = null;
let _initialized = false;

async function getDb() {
  if (_db) return _db;
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required (SQLite support has been removed; this app is Postgres-only).');
  }
  _db = await initPostgres();
  usePostgres = true;
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
      narrative_outline TEXT,
      narrative_directions TEXT,
      narrative_outlines TEXT,
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

  // Per-member novel curation (Phase 2): each member can include/exclude
  // sessions for THEIR OWN published fork. A row exists only when a member
  // deviates from the default (included). The SM's sessions.novel_include is
  // separate and never cascades to members (members start clean).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS session_includes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      include BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      edited_at TIMESTAMP,
      UNIQUE (user_id, session_id)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_session_includes_user ON session_includes(user_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_session_includes_session ON session_includes(session_id)');

  // Per-member book metadata (Phase 2b): each member's own cover / back-cover /
  // title-page image and book title for THEIR published fork. Empty image fields
  // fall back to the SM campaign values at render time (every book has a cover).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS novel_book_meta (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      cover_image_url TEXT,
      back_cover_image_url TEXT,
      title_image_url TEXT,
      book_title TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      edited_at TIMESTAMP,
      UNIQUE (user_id, campaign_id)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_novel_book_meta_campaign ON novel_book_meta(campaign_id)');

  // Pass 1 (narrative rework) — per-version narrative planning fields:
  //   narrative_outline    = JSON { intro, sections:[{panel_index,outline}], outro }
  //                          produced FREE during extraction so the Review tab can
  //                          preview "what each gap's prose will say" before any
  //                          narrative prose is generated.
  //   narrative_directions = JSON keyed by gap ('opening' | 'between:<i>' | 'closing')
  //                          of per-gap steering text that gets injected into the
  //                          narrative-generation prompt (and thus every per-gap Regen).
  await pool.query('ALTER TABLE session_forks ADD COLUMN IF NOT EXISTS narrative_outline TEXT');
  await pool.query('ALTER TABLE session_forks ADD COLUMN IF NOT EXISTS narrative_directions TEXT');
  await pool.query('ALTER TABLE session_forks ADD COLUMN IF NOT EXISTS narrative_outlines TEXT');
  // Narrative Styles — per-version narrative VOICE preset (the prose analog of
  // art style). NULL => the default 'classic' voice (current behavior preserved).
  // Stores the style id string only; the prompt text for each style lives in
  // routes/narrative.js (NARRATIVE_STYLES). Read/written on the caller's fork.
  await pool.query('ALTER TABLE session_forks ADD COLUMN IF NOT EXISTS narrative_style TEXT');
  // narrative_style_used = the style actually used the last time the prose was
  // generated (stamped at generation). Lets each narrative panel show the true
  // voice it was written in, independent of the current dropdown selection.
  await pool.query('ALTER TABLE session_forks ADD COLUMN IF NOT EXISTS narrative_style_used TEXT');

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

// migrateArchives: idempotent (runs every boot). Campaign Archives lets any
// member save off an image they love so a later regen/re-extract can't lose
// it. At archive time the image BYTES are copied into an R2 archives/ key
// (the archive owns its copy), so reference-counted cleanup of moment and
// character images never deletes an archived picture. Provenance IDs use
// ON DELETE SET NULL; campaign_id is the per-campaign list anchor and
// CASCADEs. image_type is a hard-coded set today: 'character' | 'moment'.
async function migrateArchives(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaign_archives (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
      fork_id INTEGER REFERENCES session_forks(id) ON DELETE SET NULL,
      moment_id INTEGER REFERENCES moments(id) ON DELETE SET NULL,
      image_type TEXT NOT NULL,
      title TEXT,
      image_url TEXT NOT NULL,
      image_prompt TEXT,
      public BOOLEAN DEFAULT FALSE,
      archived_by INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_archives_campaign ON campaign_archives(campaign_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_archives_session ON campaign_archives(session_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_archives_fork ON campaign_archives(fork_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_archives_moment ON campaign_archives(moment_id)');
  // character_id ties a 'character' archive to its character (canonical when
  // fork_id is NULL, or a per-fork snapshot). Added post-table; idempotent.
  await pool.query('ALTER TABLE campaign_archives ADD COLUMN IF NOT EXISTS character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_archives_character ON campaign_archives(character_id)');
  // source_url = the ORIGINAL image URL that was archived (the archived copy
  // lives in image_url). Lets the chest reflect whether THIS image is saved.
  await pool.query('ALTER TABLE campaign_archives ADD COLUMN IF NOT EXISTS source_url TEXT');
  await pool.query('ALTER TABLE campaign_archives ADD COLUMN IF NOT EXISTS art_style TEXT');
  // art_style_name = resolved DISPLAY name of a custom art style, stamped at
  // archive time so the label ("Custom: <name>") is identical for every viewer
  // and survives later renames, deletes, or tier lapses. Null for presets.
  await pool.query('ALTER TABLE campaign_archives ADD COLUMN IF NOT EXISTS art_style_name TEXT');
  // public = owner opted this archived image into the anonymous Public Library.
  await pool.query('ALTER TABLE campaign_archives ADD COLUMN IF NOT EXISTS public BOOLEAN DEFAULT FALSE');
  await pool.query("CREATE INDEX IF NOT EXISTS idx_archives_public ON campaign_archives(created_at DESC, id DESC) WHERE public = TRUE");

  // public_stories: a fork owner's graphic-novel PDF published to the Public
  // Library (Stories tab). One row per (campaign, publisher) -- re-publishing
  // upserts (refreshes the frozen PDF). author_name snapshots the pen name at
  // publish time for display + search. public = moderation flag (admins unpublish).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public_stories (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      author_name TEXT,
      title TEXT NOT NULL,
      pdf_url TEXT NOT NULL,
      cover_url TEXT,
      public BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_public_stories_public ON public_stories(created_at DESC, id DESC) WHERE public = TRUE");
  await pool.query('CREATE INDEX IF NOT EXISTS idx_public_stories_author ON public_stories(lower(author_name))');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_public_stories_user ON public_stories(user_id)');
  // Public story pages (companion: PUBLIC_STORY_PAGES_SPEC.md). snapshot freezes
  // the rendered content at publish so the public HTML view never reflects later
  // edits; slug = canonical URL slug; blurb = optional author teaser; teaser =
  // auto first narrative paragraph. Guarded ALTERs are safe to re-run.
  await pool.query('ALTER TABLE public_stories ADD COLUMN IF NOT EXISTS snapshot JSONB');
  await pool.query('ALTER TABLE public_stories ADD COLUMN IF NOT EXISTS slug TEXT');
  await pool.query('ALTER TABLE public_stories ADD COLUMN IF NOT EXISTS blurb TEXT');
  await pool.query('ALTER TABLE public_stories ADD COLUMN IF NOT EXISTS teaser TEXT');
  // Each Publish is now its own Library entry -- drop the legacy one-row-per
  // (campaign, publisher) uniqueness so multiple stories can coexist per campaign.
  await pool.query('ALTER TABLE public_stories DROP CONSTRAINT IF EXISTS public_stories_campaign_id_user_id_key');

  // public_story_images: one row per distinct image URL a published story uses,
  // so releaseImage() protects those URLs from reference-counted deletion the
  // same way campaign_archives does. ON DELETE CASCADE clears them on unpublish.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public_story_images (
      id SERIAL PRIMARY KEY,
      story_id INTEGER NOT NULL REFERENCES public_stories(id) ON DELETE CASCADE,
      image_url TEXT NOT NULL
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_public_story_images_url ON public_story_images(image_url)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_public_story_images_story ON public_story_images(story_id)');
}

// migrateCasting: idempotent. Explicit per-panel casting (Pass 2). A panel's
// rows here are authoritative ONLY when moments.cast_explicit = true; until
// then the storyboard/Review fall back to name-match inference. Keyed on
// moment_id (already fork-scoped), so a player's casting stays on their
// version. ON DELETE CASCADE so deleting a moment/character/asset cleans up.
async function migrateCasting(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS moment_characters (
      id SERIAL PRIMARY KEY,
      moment_id INTEGER NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      UNIQUE (moment_id, character_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS moment_assets (
      id SERIAL PRIMARY KEY,
      moment_id INTEGER NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
      asset_id INTEGER NOT NULL REFERENCES campaign_assets(id) ON DELETE CASCADE,
      UNIQUE (moment_id, asset_id)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_moment_characters_moment ON moment_characters(moment_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_moment_assets_moment ON moment_assets(moment_id)');

  // Print-on-demand orders (Lulu and any future vendor via PrintProvider).
  // One row per placed order. session_id NULL = whole-campaign novel.
  // Money columns are the vendor's landed cost vs what we charge the user.
  // payment_status: pending|stubbed|paid|payment_failed|refunded.
  // status: neutral provider lifecycle (created|accepted|in_production|
  // shipped|rejected|canceled|order_failed).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_orders (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      campaign_id INTEGER REFERENCES campaigns(id),
      session_id INTEGER,
      external_id TEXT,
      provider TEXT NOT NULL DEFAULT 'lulu',
      provider_order_id TEXT,
      pod_package_id TEXT,
      binding TEXT,
      color_tier TEXT,
      cover_finish TEXT,
      page_count INTEGER,
      quantity INTEGER NOT NULL DEFAULT 1,
      interior_pdf_url TEXT,
      cover_pdf_url TEXT,
      ship_name TEXT,
      ship_street1 TEXT,
      ship_street2 TEXT,
      ship_city TEXT,
      ship_state TEXT,
      ship_postcode TEXT,
      ship_country TEXT,
      ship_phone TEXT,
      shipping_level TEXT,
      provider_cost NUMERIC,
      currency TEXT DEFAULT 'USD',
      customer_charge NUMERIC,
      payment_status TEXT DEFAULT 'pending',
      card_brand TEXT,
      card_last4 TEXT,
      stripe_session_id TEXT,
      stripe_payment_intent_id TEXT,
      status TEXT DEFAULT 'created',
      tracking_url TEXT,
      tracking_number TEXT,
      carrier TEXT,
      error TEXT,
      order_name TEXT,
      book_title TEXT,
      campaign_name TEXT,
      source_kind TEXT,
      source_user_id INTEGER,
      source_user_name TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_print_orders_user ON print_orders(user_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_print_orders_campaign ON print_orders(campaign_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_print_orders_provider_job ON print_orders(provider_order_id)');
  // Added after the table shipped — CREATE above won't alter existing tables.
  await pool.query('ALTER TABLE print_orders ADD COLUMN IF NOT EXISTS order_name TEXT');
  await pool.query('ALTER TABLE print_orders ADD COLUMN IF NOT EXISTS book_title TEXT');
  await pool.query('ALTER TABLE print_orders ADD COLUMN IF NOT EXISTS tracking_number TEXT');
  await pool.query('ALTER TABLE print_orders ADD COLUMN IF NOT EXISTS campaign_name TEXT');
  await pool.query('ALTER TABLE print_orders ADD COLUMN IF NOT EXISTS source_kind TEXT');
  await pool.query('ALTER TABLE print_orders ADD COLUMN IF NOT EXISTS source_user_id INTEGER');
  await pool.query('ALTER TABLE print_orders ADD COLUMN IF NOT EXISTS source_user_name TEXT');
  await pool.query('ALTER TABLE print_orders ADD COLUMN IF NOT EXISTS card_brand TEXT');
  await pool.query('ALTER TABLE print_orders ADD COLUMN IF NOT EXISTS card_last4 TEXT');
  await pool.query('ALTER TABLE print_orders ADD COLUMN IF NOT EXISTS stripe_session_id TEXT');
  await pool.query('ALTER TABLE print_orders ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT');
}

// migratePerfIndexes: idempotent (runs every boot). Performance indexes for
// scale. Postgres does NOT auto-index foreign-key columns -- only PKs and
// UNIQUE constraints -- so the hot-path FK filters below were doing sequential
// scans: invisible at small row counts, brutal at large ones. All IF NOT
// EXISTS, so a re-run is a no-op. Each wrapped in try/catch so one bad index
// can never kill the deploy.
//
// NOTE: plain CREATE INDEX takes a brief exclusive lock while it builds.
// That's instant on today's small tables -- which is exactly why we add them
// NOW, before the tables get big. If these were already huge you'd want
// CREATE INDEX CONCURRENTLY instead (not needed yet).
async function migratePerfIndexes(pool) {
  const idx = [
    // --- Hot-path foreign-key / filter indexes (issue #1) ---
    // The single most-run query in the app: SELECT * FROM moments
    // WHERE fork_id = ? ORDER BY panel_order. Composite serves filter + sort.
    'CREATE INDEX IF NOT EXISTS idx_moments_fork_order ON moments(fork_id, panel_order)',
    'CREATE INDEX IF NOT EXISTS idx_moments_session ON moments(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_sessions_campaign ON sessions(campaign_id)',
    'CREATE INDEX IF NOT EXISTS idx_characters_campaign ON characters(campaign_id)',
    'CREATE INDEX IF NOT EXISTS idx_assets_campaign ON campaign_assets(campaign_id)',
    // session_characters(fork_id) is already covered by the
    // UNIQUE(fork_id, character_id) implicit index. session_id is not, and
    // session-delete sweeps filter by it.
    'CREATE INDEX IF NOT EXISTS idx_sc_session ON session_characters(session_id)',

    // --- releaseImage() reference-check indexes (issue #2) ---
    // releaseImage does an exact-match lookup on each image URL column before
    // deleting an R2 object -- previously unindexed full scans on every
    // regenerate + every delete. We index the columns on the LARGE tables.
    // (characters' 6-column OR is intentionally left unindexed: that table
    //  stays small vs moments; revisit with a normalized image-ref table or
    //  partial indexes only if it ever shows up hot.)
    'CREATE INDEX IF NOT EXISTS idx_moments_image ON moments(image)',
    'CREATE INDEX IF NOT EXISTS idx_sc_refurl ON session_characters(reference_url)',
    'CREATE INDEX IF NOT EXISTS idx_assets_imageurl ON campaign_assets(image_url)',
    'CREATE INDEX IF NOT EXISTS idx_archives_imageurl ON campaign_archives(image_url)',
    'CREATE INDEX IF NOT EXISTS idx_archives_sourceurl ON campaign_archives(source_url)'
  ];
  for (const sql of idx) {
    try { await pool.query(sql); } catch (e) { console.error('  [migratePerfIndexes] skipped:', e.message); }
  }
  console.log('  Performance indexes ensured.');
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

// Per-member novel curation: map of session_id -> boolean (included) for a given
// book owner in a campaign. ownerUserId null = the SM canonical book (uses
// sessions.novel_include). For a member, an explicit session_includes row wins;
// absent = included (members start clean, the SM's choices never cascade).
async function effectiveIncludeMap(db, campaignId, ownerUserId) {
  const isOn = function(v) { return !(v === false || v === 0 || v === 'f' || v === 'false'); };
  const sessions = await db.prepare('SELECT id, novel_include FROM sessions WHERE campaign_id = ?').all(campaignId);
  const map = {};
  if (!ownerUserId) {
    for (let i = 0; i < sessions.length; i++) { map[sessions[i].id] = isOn(sessions[i].novel_include); }
    return map;
  }
  const rows = await db.prepare(
    'SELECT si.session_id, si.include FROM session_includes si JOIN sessions s ON s.id = si.session_id WHERE si.user_id = ? AND s.campaign_id = ?'
  ).all(ownerUserId, campaignId);
  const ov = {};
  for (let i = 0; i < rows.length; i++) { ov[rows[i].session_id] = isOn(rows[i].include); }
  for (let i = 0; i < sessions.length; i++) {
    const id = sessions[i].id;
    map[id] = (id in ov) ? ov[id] : true;
  }
  return map;
}

// Per-member book metadata: returns a member's raw override row (cover/back/title
// images + book_title) or null. Empty image fields fall back to the SM campaign
// values at render time; ownerUserId null = the SM canonical book (no override).
async function effectiveBookMeta(db, campaignId, ownerUserId) {
  if (!ownerUserId) return null;
  const row = await db.prepare(
    'SELECT cover_image_url, back_cover_image_url, title_image_url, book_title FROM novel_book_meta WHERE user_id = ? AND campaign_id = ?'
  ).get(ownerUserId, campaignId);
  return row || null;
}

// Read an integer app_settings value by key, falling back to `def` on miss/error.
async function getAppSettingInt(key, def) {
  try {
    const db = await getDb();
    const r = await db.prepare("SELECT value FROM app_settings WHERE setting_key = ?").get(key);
    const n = r && r.value != null ? parseInt(r.value, 10) : NaN;
    return Number.isFinite(n) ? n : def;
  } catch (e) { return def; }
}

module.exports = { getDb, isPostgres, getOrCreateDmFork, getDmForkId, getViewableForkId, effectiveIncludeMap, effectiveBookMeta, getAppSettingInt };
