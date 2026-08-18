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
  // Extract (Generate Story) jobs -- async pattern mirroring narrative_jobs, so the
  // long Claude extraction runs off the request cycle and never hits the gateway
  // (Cloudflare 100s) timeout. Client submits, polls /api/extract/job/:id.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS extract_jobs (
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
  await pool.query('CREATE INDEX IF NOT EXISTS idx_extract_jobs_user ON extract_jobs(user_id, status)');
  // One-time (idempotent) relabel: the establishing/title-image moment used to be
  // stored with the literal title 'Title Image'. Show the session's own name instead,
  // everywhere the moment title renders. Matches nothing on later boots (no rows keep
  // that literal), so it is safe to run each startup.
  await pool.query(`
    UPDATE moments SET title = s.name
    FROM session_forks sf JOIN sessions s ON s.id = sf.session_id
    WHERE moments.fork_id = sf.id AND moments.kind = 'establishing'
      AND moments.title = 'Title Image' AND s.name IS NOT NULL AND s.name <> ''
  `);

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
    // v3.0.558 -- TD-345. NULL means "not set", and that is a real state that must survive: Ian
    // ruled that existing characters stay blank, so a cast with no heights renders exactly as it
    // does today and the feature appears only when someone opts in. NO DEFAULT -- a default of 6
    // would silently declare every existing character six feet tall.
    'ALTER TABLE characters ADD COLUMN IF NOT EXISTS height_ft REAL',
    'ALTER TABLE novel_book_meta ADD COLUMN IF NOT EXISTS title_color TEXT',
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
    // v3.0.485 -- campaign-level steering (GENRE_AND_CAMPAIGN_PROMPT_SPEC.md, TD-217 + TD-189).
    // genres is an ORDERED JSON array of slugs; the first is primary. Resolve it
    // ONLY through services/genres.js campaignGenres() -- NULL and [] must both read
    // as Fantasy, and nothing may re-derive that rule a second time.
    'ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS genres TEXT',
    'ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS campaign_prompt TEXT',
    // v3.0.487 -- Library genre facet. text[] with a GIN index, NOT a JSON string:
    // this column is queried ACROSS rows (filter every public story by genre), which
    // is the one place in this feature where the storage shape matters. A JSON string
    // would mean LIKE '%horror%' over the whole table -- fine at ten stories, not at
    // tens of thousands. campaigns.genres stays a JSON string because it is only ever
    // read whole, one row at a time. SNAPSHOT at publish time, never a live join.
    'ALTER TABLE public_stories ADD COLUMN IF NOT EXISTS genres text[]',
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
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_token TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_token_expires TIMESTAMP',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_plan TEXT',
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

  // v3.0.485 -- GENRE BACKFILL. Fantasy is the default and is true of very nearly
  // every campaign that exists. Runs after the ALTERs, is idempotent, and touches
  // only rows that have never been set. NOTE the reader (services/genres.js
  // campaignGenres) already resolves NULL and [] to Fantasy, so this backfill is a
  // convenience for querying, NOT the thing that makes the default work -- a
  // campaign created between the ALTER and this line still reads correctly.
  try {
    const _gb = await pool.query("UPDATE campaigns SET genres = '[\"fantasy\"]' WHERE genres IS NULL OR genres = '' OR genres = '[]'");
    if (_gb && _gb.rowCount) console.log('[db] genre backfill: ' + _gb.rowCount + ' campaign(s) set to Fantasy');
  } catch(e) { console.error('[db] genre backfill failed: ' + (e && e.message)); }

  // v3.0.487 -- the Library facet index, and a ONE-OFF snapshot for stories that
  // were published before genre existed. They take their campaign's genres once;
  // after this the snapshot stands and is never re-read from the campaign, so
  // editing a campaign's genre cannot silently re-file a book already published.
  try { await pool.query('CREATE INDEX IF NOT EXISTS idx_public_stories_genres ON public_stories USING GIN (genres)'); } catch(e) { console.error('[db] public_stories genre index failed: ' + (e && e.message)); }
  try {
    const _sb = await pool.query(
      "UPDATE public_stories ps SET genres = COALESCE((SELECT ARRAY(SELECT jsonb_array_elements_text(c.genres::jsonb)) FROM campaigns c WHERE c.id = ps.campaign_id), ARRAY['fantasy']) " +
      'WHERE ps.genres IS NULL'
    );
    if (_sb && _sb.rowCount) console.log('[db] public_stories genre snapshot: ' + _sb.rowCount + ' story(ies) back-filled');
  } catch(e) { console.error('[db] public_stories genre backfill failed: ' + (e && e.message)); }

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
      per_user_limit INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_promo_codes_code ON promo_codes(code)');
  await pool.query('ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS per_user_limit INTEGER NOT NULL DEFAULT 1');
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

  // v3.0.453 -- CAMPAIGN VERSIONS (TD-242, Model B). Runs immediately after
  // migrateForks because it groups the forks that migration guarantees exist,
  // and before migrateArchives so nothing else has touched session_forks yet.
  // STAGE 1 IS SCHEMA AND BACKFILL ONLY -- no route and no client reads
  // version_id yet, so the worst case is a column nothing uses.
  await migrateCampaignVersions(pool);

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
// One-time backfill: seed fork_book_prefs (chooser = fork = the existing user) from the
// two current stores -- novel_book_meta (covers) and campaign_members.member_prefs
// (layout/art/narrative). Idempotent + guarded by an app_settings flag so it runs once.
async function migrateForkBookPrefs(pool) {
  try {
    const done = await pool.query("SELECT value FROM app_settings WHERE setting_key = 'fork_book_prefs_v1'");
    if (done.rows && done.rows.length) return;
    const map = {};
    const nbm = await pool.query('SELECT user_id, campaign_id, cover_image_url, back_cover_image_url, title_image_url, book_title, title_color FROM novel_book_meta');
    for (const r of nbm.rows) {
      const k = r.user_id + ':' + r.campaign_id;
      if (!map[k]) map[k] = { u: r.user_id, c: r.campaign_id, p: {} };
      const p = map[k].p;
      if (r.cover_image_url) p.cover_image_url = r.cover_image_url;
      if (r.back_cover_image_url) p.back_cover_image_url = r.back_cover_image_url;
      if (r.title_image_url) p.title_image_url = r.title_image_url;
      if (r.book_title) p.book_title = r.book_title;
      if (r.title_color) p.title_color = r.title_color;
    }
    const cm = await pool.query("SELECT user_id, campaign_id, member_prefs FROM campaign_members WHERE member_prefs IS NOT NULL AND member_prefs <> ''");
    for (const r of cm.rows) {
      const k = r.user_id + ':' + r.campaign_id;
      if (!map[k]) map[k] = { u: r.user_id, c: r.campaign_id, p: {} };
      try {
        const mp = JSON.parse(r.member_prefs) || {};
        if (mp.art_style != null) map[k].p.art_style = mp.art_style;
        if (mp.narrative_style != null) map[k].p.narrative_style = mp.narrative_style;
        if (mp.layout_opts && typeof mp.layout_opts === 'object') map[k].p.layout_opts = mp.layout_opts;
      } catch (e) {}
    }
    let n = 0;
    for (const k in map) {
      const e = map[k];
      await pool.query(
        // v3.0.455 -- version_id 0 (the base book) and an ON CONFLICT matching the new key.
        'INSERT INTO fork_book_prefs (chooser_user_id, fork_user_id, campaign_id, version_id, prefs, updated_at) ' +
        'VALUES ($1, $1, $2, 0, $3, CURRENT_TIMESTAMP) ' +
        'ON CONFLICT (chooser_user_id, fork_user_id, campaign_id, version_id) DO NOTHING',
        [e.u, e.c, JSON.stringify(e.p)]
      );
      n++;
    }
    await pool.query("INSERT INTO app_settings (setting_key, value) VALUES ('fork_book_prefs_v1', '1') ON CONFLICT (setting_key) DO NOTHING");
    console.log('  [migrateForkBookPrefs] backfilled ' + n + ' fork-view pref rows');
  } catch (e) {
    console.error('  [migrateForkBookPrefs] skipped:', e.message);
  }
}

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
  // v3.0.439 -- MANY VERSIONS PER USER PER SESSION (TD-194).
  // `name` is what the reader types when they press New Version. NULL means an original fork made
  // before this existed, and the UI shows the owner name for those, exactly as it does today.
  await pool.query('ALTER TABLE session_forks ADD COLUMN IF NOT EXISTS name TEXT');
  // And the constraint that made this impossible. Note the ORDER IT IS DONE IN: every query that
  // resolves "this user's fork for this session" was made deterministic FIRST (v3.0.439, 15 sites
  // across sessions.js, pdf.js, images.js, narrative.js, extract.js, invites.js and getViewableForkId
  // above). None of them had an ORDER BY, because the constraint guaranteed at most one row -- so
  // dropping it first would have turned fifteen queries into arbitrary-row lookups, correct today and
  // silently wrong the first time a second fork existed. Postgres names the constraint for us.
  await pool.query('ALTER TABLE session_forks DROP CONSTRAINT IF EXISTS session_forks_session_id_user_id_key');
  // A user may now hold several versions of one session, but not two with the SAME NAME -- which is
  // the constraint that actually protects the reader. Partial, so the unnamed originals are exempt.
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_forks_named ON session_forks(session_id, user_id, name) WHERE name IS NOT NULL");
  // v3.0.441 -- ONE CANONICAL PER SESSION, ENFORCED (TD-194). Three lookups in this file resolve the
  // DM fork with no ORDER BY, on the assumption there is exactly one. Until now that was a convention
  // held up by the unique constraint v3.0.439 dropped; this makes it an invariant Postgres keeps.
  // WRAPPED, because creating a unique index fails if duplicates already exist -- and a migration
  // that throws takes startup down with it, which is precisely how v3.0.439 broke. Ian confirmed zero
  // duplicates on both environments, so this should take; if it ever cannot, the app still boots and
  // says why.
  try {
    await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_forks_one_dm ON session_forks(session_id) WHERE role = 'dm'");
  } catch (e) {
    console.error('[forks] could not enforce one canonical fork per session -- there are duplicates. ' +
      "Run: SELECT session_id, COUNT(*) FROM session_forks WHERE role='dm' GROUP BY 1 HAVING COUNT(*)>1;  (" + ((e && e.message) || e) + ')');
  }
  // ONE-OFF BACKFILL: give every existing fork the name it is currently shown under, so a reader can
  // rename it later rather than being stuck with a label the app invented. Only where name IS NULL,
  // so it never overwrites anything a reader has chosen.
  // NOT "You (your version)" for a player: that label is VIEWER-RELATIVE and cannot be stored --
  // the same row reads as "You" to its owner and as a person's name to everyone else. The stored
  // name has to be viewer-neutral, and the owner is already shown beside it.
  await pool.query("UPDATE session_forks SET name = 'Canonical' WHERE name IS NULL AND role = 'dm'");
  await pool.query("UPDATE session_forks SET name = 'Original' WHERE name IS NULL AND role <> 'dm'");

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
      title_color TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      edited_at TIMESTAMP,
      UNIQUE (user_id, campaign_id)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_novel_book_meta_campaign ON novel_book_meta(campaign_id)');

  // Fork-view book prefs (SM/member overlay): one JSON blob per (chooser, fork, campaign).
  // chooser_user_id = who is making the choices; fork_user_id = whose fork content (the
  // canonical fork = the SM's user id). A member's own book is (M, M, C); the SM's own
  // overlay on member X's fork is (SM, X, C) -- a separate slot from X's own (X, X, C).
  // prefs JSON = { cover_image_url, back_cover_image_url, title_image_url, book_title,
  //   title_color, layout_opts:{...}, art_style, narrative_style }. New layout options
  // just go in the JSON -- no schema change.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fork_book_prefs (
      id SERIAL PRIMARY KEY,
      chooser_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      fork_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      prefs TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (chooser_user_id, fork_user_id, campaign_id)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_fork_book_prefs_lookup ON fork_book_prefs(chooser_user_id, fork_user_id, campaign_id)');

  // v3.0.589 -- TD-179 STAGE 1. THE IMPERSONATION AUDIT TRAIL.
  // Spec: ADMIN_IMPERSONATION_SPEC.md sections 7 and 8. This table is what makes support access
  // DEFENSIBLE if it is ever questioned, and it is half of what makes the privacy-policy clause
  // TRUE -- the other half is the deny-list middleware. Ian, 2026-08-02: "put that we need to add
  // it to the Privacy policy." A promise the code does not keep is worse than no promise, so the
  // clause must not ship before this and the guard do.
  //
  // admin_email AND target_email ARE DENORMALISED ON PURPOSE. ADMIN_EMAILS is an env var and the
  // users table can be deleted from; if either changes later, a row that recorded only ids would
  // quietly stop saying WHO did what. The record has to survive the thing it is a record of.
  //
  // ON DELETE SET NULL, not CASCADE: deleting a user must not erase the evidence that support
  // entered their account. The denormalised emails carry the meaning after the id goes.
  //
  // tokens_spent -- v3.0.589, Ian's decision. He wants to SPEND tokens while impersonating (you
  // cannot reproduce a failing Optimize run otherwise) and then give them back, generously. Guessing
  // how many were spent is exactly the sort of thing nobody does accurately after the fact, so the
  // session counts them.
  //
  // RETENTION: these rows are the record, not scratch data. Do NOT include them in the TF-05
  // retention purge (TD-044).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_impersonations (
      id SERIAL PRIMARY KEY,
      admin_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      admin_email TEXT NOT NULL,
      target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      target_email TEXT NOT NULL,
      reason TEXT,
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ended_at TIMESTAMP,
      end_reason TEXT
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_admin_imp_open ON admin_impersonations(id) WHERE ended_at IS NULL');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_admin_imp_target ON admin_impersonations(target_user_id, started_at DESC)');

  // v3.0.455 -- BOOK PREFS ARE PER VERSION (TD-242 stage 2b).
  //
  // WHY A SENTINEL 0 AND NOT NULL + A COALESCE INDEX. A nullable version_id would need a UNIQUE
  // INDEX on the expression (chooser, fork, campaign, COALESCE(version_id,0)) and an ON CONFLICT
  // repeating that expression EXACTLY. v3.0.440 is on record for what happens when a constraint and
  // an ON CONFLICT drift apart: Postgres refuses the statement, the migration throws, and startup
  // goes down with it. A NOT NULL column with a plain constraint and a plain ON CONFLICT cannot
  // drift. 0 is not a version id and never will be -- SERIAL starts at 1.
  //
  // 0 MEANS THE BASE BOOK, AND THE CANONICAL VERSION MAPS TO IT. Every row that exists today is
  // the campaign's canonical book, and it stays exactly where it is: no data moves, no backfill,
  // and a Story Master's approved layout is not touched by this build. Only a NAMED version gets
  // rows of its own. That is what stops two versions of one user sharing one lastOptimized entry
  // -- which is the same prefs row today, so saving the second would overwrite the first's
  // approved layout and its saved PDF with no error and no way back.
  await pool.query('ALTER TABLE fork_book_prefs ADD COLUMN IF NOT EXISTS version_id INTEGER NOT NULL DEFAULT 0');
  // ORDER MATTERS: add the column (existing rows default to 0) BEFORE dropping the old key, so
  // there is no window in which duplicates could be written.
  await pool.query('ALTER TABLE fork_book_prefs DROP CONSTRAINT IF EXISTS fork_book_prefs_chooser_user_id_fork_user_id_campaign_id_key');
  try {
    await pool.query('ALTER TABLE fork_book_prefs ADD CONSTRAINT fork_book_prefs_scope_key UNIQUE (chooser_user_id, fork_user_id, campaign_id, version_id)');
  } catch (e) {
    if (!/already exists/i.test((e && e.message) || '')) {
      console.error('[versions] fork_book_prefs unique key not applied: ' + ((e && e.message) || e));
    }
  }
  await pool.query('CREATE INDEX IF NOT EXISTS idx_fork_book_prefs_scope ON fork_book_prefs(chooser_user_id, fork_user_id, campaign_id, version_id)');

  // Same treatment for per-session curation: which sessions a VERSION includes in its book.
  await pool.query('ALTER TABLE session_includes ADD COLUMN IF NOT EXISTS version_id INTEGER NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE session_includes DROP CONSTRAINT IF EXISTS session_includes_user_id_session_id_key');
  try {
    await pool.query('ALTER TABLE session_includes ADD CONSTRAINT session_includes_scope_key UNIQUE (user_id, session_id, version_id)');
  } catch (e) {
    if (!/already exists/i.test((e && e.message) || '')) {
      console.error('[versions] session_includes unique key not applied: ' + ((e && e.message) || e));
    }
  }
  await migrateForkBookPrefs(pool);

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
  // narrative_verbosity = per-fork length dial for generated prose: 'low' | 'med' | 'high'.
  // NEW forks default to 'med' (column default below). EXISTING forks predate the dial: they are
  // backfilled to 'high' one time so already-written books keep their original verbose length.
  // Remembered and inherited like narrative_style; applied at Generate Narrative.
  await pool.query("ALTER TABLE session_forks ADD COLUMN IF NOT EXISTS narrative_verbosity TEXT");
  await pool.query("UPDATE session_forks SET narrative_verbosity = 'high' WHERE narrative_verbosity IS NULL");
  await pool.query("ALTER TABLE session_forks ALTER COLUMN narrative_verbosity SET DEFAULT 'med'");

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
    -- v3.0.440 -- WAS: ON CONFLICT (session_id, user_id) DO NOTHING.
    -- v3.0.439 dropped that unique constraint so a user can hold several versions of a session, and
    -- Postgres requires a matching unique index for an ON CONFLICT target -- so this backfill, which
    -- runs on EVERY BOOT, threw "there is no unique or exclusion constraint matching the ON CONFLICT
    -- specification" and took startup down with it. Dropping a constraint is not only a schema change:
    -- it invalidates every ON CONFLICT that named it.
    -- NOT EXISTS says what this actually means and is stricter than the clause it replaces: ONE DM
    -- fork per session. The old form only blocked a duplicate for the SAME user, so a session whose
    -- DM had changed would have quietly gained a second DM fork on the next boot.
    WHERE NOT EXISTS (
      SELECT 1 FROM session_forks f WHERE f.session_id = s.id AND f.role = 'dm'
    )
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

// migrateCampaignVersions: idempotent (runs every boot). TD-242 / USER_FORKS_SPEC.md Model B.
//
// THE CONCEPT. A "version" is CAMPAIGN-level and owns AT MOST ONE FORK PER SESSION. That last
// clause is the whole point: it is the uniqueness v3.0.439 dropped from session_forks, put back one
// level up, where a BOOK can use it. Before this, "which fork of session 3 does this book use?" had
// no answer once a reader held two versions of that session -- the question was not a UI gap, it was
// a missing concept.
//
// FALLTHROUGH. A version with no fork for a session shows the CANONICAL. That is what makes a
// version cheap: branch one session, leave the other seven alone, and the book is the Story
// Master's everywhere you did not touch it.
//
// OWNERSHIP OF THE CANONICAL IS DERIVED, NOT STORED. Ian, 2026-08-06: "the Canonical version is
// owned by whoever has the dm flag on the campaign but access to it is shared to the members." So a
// canonical row carries user_id NULL and the owner is read from campaign_members.role='dm'.
// Storing it here would be a SECOND place the same fact is written down, and TD-194 cost thirteen
// builds because one rule lived in twelve places. It also survives a Story Master handover for
// free, which the fork-owner path does not.
//
// DRAFT/READY IS UNCHANGED AND STAYS PER FORK (session_forks.player_access_status). A version is
// not a visibility unit. Stage 2 reads it as: another member sees a version when any of its forks
// is Ready, and on the sessions where that version's fork is still draft they fall through to the
// canonical -- the same rule as a session that was never branched.
async function migrateCampaignVersions(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaign_versions (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      is_canonical BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      edited_at TIMESTAMP
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_campaign_versions_campaign ON campaign_versions(campaign_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_campaign_versions_user ON campaign_versions(user_id)');
  // ONE canonical per campaign, enforced rather than assumed -- the same lesson as idx_forks_one_dm.
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_versions_canonical ON campaign_versions(campaign_id) WHERE is_canonical');
  // A person cannot hold two versions of one campaign under the same name. Partial, so it never
  // looks at the canonical row (whose user_id is NULL by design and would defeat the index anyway).
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_versions_named ON campaign_versions(campaign_id, user_id, name) WHERE NOT is_canonical');

  // ON DELETE SET NULL, deliberately: an orphaned fork is recoverable and the backfill below will
  // re-home it by name on the next boot. ON DELETE CASCADE here would make deleting a version
  // destroy content, which is a Stage 3 product decision and not one to make by schema default.
  await pool.query('ALTER TABLE session_forks ADD COLUMN IF NOT EXISTS version_id INTEGER REFERENCES campaign_versions(id) ON DELETE SET NULL');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_forks_version ON session_forks(version_id)');

  // ---- BACKFILL -------------------------------------------------------------------------------
  // Every campaign gets its canonical, including one with no sessions yet, so the fallthrough
  // target always exists before anything can point at it.
  await pool.query(`
    INSERT INTO campaign_versions (campaign_id, user_id, name, is_canonical, created_at)
    SELECT c.id, NULL, 'Canonical', true, NOW()
    FROM campaigns c
    WHERE NOT EXISTS (
      SELECT 1 FROM campaign_versions v WHERE v.campaign_id = c.id AND v.is_canonical
    )
  `);

  // Player versions group by (campaign, owner, NAME). Measured on both environments 2026-08-06:
  // staging 7, production 11, and no group holds two forks of one session -- so the
  // (version_id, session_id) index below takes on the first boot rather than logging a failure.
  //
  // The COALESCE/NULLIF pair is the blank-name rule. Two creation paths do NOT name a fork -- the
  // older make-my-own-version path and the auto-canonical for a brand-new session -- and rely on
  // the v3.0.439 boot backfill to name them later. So a fork created since the last restart can
  // legitimately be sitting here with a NULL name (production fork 3196, staging none). It reads as
  // 'Original', which is exactly what that backfill would have called it.
  await pool.query(`
    INSERT INTO campaign_versions (campaign_id, user_id, name, is_canonical, created_at)
    SELECT DISTINCT s.campaign_id, f.user_id,
           COALESCE(NULLIF(btrim(f.name), ''), 'Original'), false, NOW()
    FROM session_forks f
    JOIN sessions s ON s.id = f.session_id
    WHERE f.role <> 'dm'
      -- v3.0.458 -- ONLY ORPHANS. THIS CLAUSE IS THE WHOLE BUG FIX.
      -- Without it this INSERT re-derived versions from fork NAMES on every boot, so renaming a
      -- version through the legacy per-fork endpoint (which writes session_forks.name and nothing
      -- else) made the next restart see a name it had no version for and CREATE ONE -- empty, since
      -- the stamping pass below only touches forks whose version_id is null, and that fork already
      -- pointed at the old version. Observed twice on staging: "Ian Watercolor" (0 sessions) beside
      -- "Ian Anime" (1 session) holding the actual fork, and "Cel-Shaded" beside "v2".
      -- A backfill that reads a MUTABLE field is only idempotent until that field is edited.
      AND f.version_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM campaign_versions v
        WHERE v.campaign_id = s.campaign_id
          AND NOT v.is_canonical
          AND v.user_id = f.user_id
          AND v.name = COALESCE(NULLIF(btrim(f.name), ''), 'Original')
      )
  `);

  // Stamp the forks. Only where version_id IS NULL, so a fork moved between versions by any later
  // code is never dragged back by a boot.
  await pool.query(`
    UPDATE session_forks f SET version_id = v.id
    FROM sessions s, campaign_versions v
    WHERE s.id = f.session_id
      AND v.campaign_id = s.campaign_id AND v.is_canonical
      AND f.role = 'dm' AND f.version_id IS NULL
  `);
  await pool.query(`
    UPDATE session_forks f SET version_id = v.id
    FROM sessions s, campaign_versions v
    WHERE s.id = f.session_id
      AND v.campaign_id = s.campaign_id AND NOT v.is_canonical
      AND v.user_id = f.user_id
      AND v.name = COALESCE(NULLIF(btrim(f.name), ''), 'Original')
      AND f.role <> 'dm' AND f.version_id IS NULL
  `);

  // ---- REPAIR: PHANTOM VERSIONS LEFT BY THE PRE-v3.0.458 BACKFILL ------------------------------
  // Signature, and it is specific enough to act on: a non-canonical version holding ZERO forks,
  // whose name equals the FORK name of another version owned by the same person in the same
  // campaign. Nothing else produces that pair. A version a reader made and simply has not branched
  // cannot match, because it has no sibling carrying its name.
  //
  // THE FORK NAME IS THE TRUTH. It is what the reader last typed; the version name is what the
  // rename never reached. So the surviving version ADOPTS its fork's name and the phantom goes.
  // Delete first, rename second -- the other order collides with idx_campaign_versions_named.
  try {
    const ph = await pool.query(`
      SELECT p.id AS phantom_id, w.id AS keep_id, f.name AS true_name, p.campaign_id, p.user_id
      FROM campaign_versions p
      JOIN campaign_versions w
        ON w.campaign_id = p.campaign_id AND w.user_id = p.user_id
       AND w.id <> p.id AND NOT w.is_canonical
      JOIN session_forks f ON f.version_id = w.id AND f.name = p.name
      WHERE NOT p.is_canonical
        AND NOT EXISTS (SELECT 1 FROM session_forks x WHERE x.version_id = p.id)
    `);
    for (const r of ph.rows) {
      await pool.query('DELETE FROM campaign_versions WHERE id = $1', [r.phantom_id]);
      await pool.query('UPDATE campaign_versions SET name = $1, edited_at = NOW() WHERE id = $2', [r.true_name, r.keep_id]);
      console.log('  [versions] repaired: version ' + r.keep_id + ' renamed to "' + r.true_name +
        '", phantom ' + r.phantom_id + ' removed (campaign ' + r.campaign_id + ')');
    }
  } catch (e) {
    console.error('  [versions] phantom repair skipped: ' + ((e && e.message) || e));
  }

  // ---- ONE NAME STORE. session_forks.name is now a MIRROR of the version it belongs to, never an
  // independent value -- two places holding one fact is how this bug happened. Re-asserted every
  // boot so any writer that slips through is corrected rather than compounding.
  try {
    const sync = await pool.query(`
      UPDATE session_forks f SET name = v.name
      FROM campaign_versions v
      WHERE v.id = f.version_id AND f.name IS DISTINCT FROM v.name
    `);
    if (sync.rowCount) console.log('  [versions] fork names re-synced to their version: ' + sync.rowCount);
  } catch (e) {
    console.error('  [versions] fork name sync skipped: ' + ((e && e.message) || e));
  }

  // ---- THE INVARIANT --------------------------------------------------------------------------
  // WRAPPED, for the reason recorded on idx_forks_one_dm: creating a unique index fails if
  // duplicates already exist, and a migration that throws takes startup down with it -- which is
  // precisely how v3.0.439 broke staging. Verified clean on both environments before shipping; if
  // it ever cannot take, the app still boots and prints the query that finds the offender.
  try {
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_forks_version_session ON session_forks(version_id, session_id) WHERE version_id IS NOT NULL');
  } catch (e) {
    console.error('[versions] could not enforce one fork per session per version -- there are duplicates. ' +
      'Run: SELECT version_id, session_id, COUNT(*) FROM session_forks WHERE version_id IS NOT NULL ' +
      'GROUP BY 1,2 HAVING COUNT(*)>1;  (' + ((e && e.message) || e) + ')');
  }

  // ---- REPORT ---------------------------------------------------------------------------------
  // Stage 1 ships with nothing reading version_id, so this line IS the verification. An unstamped
  // fork is the one failure that would otherwise be invisible until Stage 2 quietly lost it.
  try {
    const vt = await pool.query('SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_canonical)::int AS canon FROM campaign_versions');
    const un = await pool.query('SELECT COUNT(*)::int AS c FROM session_forks WHERE version_id IS NULL');
    const t = vt.rows[0].total, c = vt.rows[0].canon, u = un.rows[0].c;
    console.log('  Campaign versions: ' + t + ' (' + c + ' canonical, ' + (t - c) + ' named); forks unstamped: ' + u);
    if (u > 0) {
      console.error('  [versions] ' + u + ' fork(s) have no version_id. ' +
        'Run: SELECT id, session_id, user_id, role, name FROM session_forks WHERE version_id IS NULL;');
    }
  } catch (e) {
    console.error('  [versions] report failed:', (e && e.message) || e);
  }
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
  // img_w / img_h / shape = the archived image's stored pixel dims and shape, copied from
  // the source moment at archive time so a later replace-from-archive restores the true
  // aspect instead of nulling dims (which mis-sizes towers). Null for legacy rows.
  await pool.query('ALTER TABLE campaign_archives ADD COLUMN IF NOT EXISTS img_w INTEGER');
  await pool.query('ALTER TABLE campaign_archives ADD COLUMN IF NOT EXISTS img_h INTEGER');
  await pool.query('ALTER TABLE campaign_archives ADD COLUMN IF NOT EXISTS shape TEXT');
  await pool.query('ALTER TABLE campaign_archives ADD COLUMN IF NOT EXISTS layout_meta TEXT');
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
  // v3.0.425 -- the tax the provider quoted, the pre-tax total it applied to, and the markup in
  // force at the time. Written per order because none of the three can be reconstructed later:
  // provider prices move, the markup is a live setting, and a quote is only true when taken.
  await pool.query('ALTER TABLE print_orders ADD COLUMN IF NOT EXISTS provider_tax NUMERIC');
  await pool.query('ALTER TABLE print_orders ADD COLUMN IF NOT EXISTS provider_cost_excl_tax NUMERIC');
  await pool.query('ALTER TABLE print_orders ADD COLUMN IF NOT EXISTS markup_pct NUMERIC');

  // v3.0.667 -- TD-465. WHAT WAS ACTUALLY SOLD.
  //
  // paper reaches the vendor SKU -- luluProvider swaps 060UW444 for 060UC444 on cream -- so it is
  // part of the physical product and part of the price. It was never written down. A cream book was
  // recorded as nothing: unreconstructable for a reorder, and indefensible in a dispute.
  //
  // order_spec is the whole selection as it stood, written ONCE at order-create and never edited.
  // Same argument as the v3.0.425 tax columns and the same one that closed TD-214: none of this can
  // be rebuilt later. Lulu prices move, covers get replaced, layouts get re-optimized. A column that
  // was never written cannot be backfilled, so every order placed before this ships is an order that
  // can never be described. That is why it went in first.
  //
  // TEXT and not JSONB deliberately: every other JSON store in this schema (layout_meta, prefs,
  // narrative_sections) is TEXT, and one row shape that reads differently from all its neighbours is
  // a trap for the next person. Nothing queries inside it -- paper has its own column for that.
  await pool.query('ALTER TABLE print_orders ADD COLUMN IF NOT EXISTS paper TEXT');
  await pool.query('ALTER TABLE print_orders ADD COLUMN IF NOT EXISTS order_spec TEXT');

  // v3.0.669 -- TD-473. THE FAILED PAYMENTS NOBODY WAS WRITING DOWN.
  //
  // invoice.payment_failed was not handled at all, so a declined card was learned only INDIRECTLY,
  // when Stripe later flipped the subscription to past_due and customer.subscription.updated fired.
  // That tells you a subscription is in trouble; it does not tell you WHICH invoice failed, WHY, or
  // WHEN, and by the time support is asked the attempts have rolled on. Stripe holds all of it, but
  // behind a dashboard nobody has open during a support conversation.
  //
  // ONE ROW PER STRIPE EVENT ID, which is what makes it idempotent under Stripe's at-least-once
  // delivery -- the same shape token_purchases uses for checkout sessions. Stripe retries webhooks,
  // and a duplicate delivery must not become a duplicate record.
  //
  // NOTHING IS EMAILED FROM THIS TABLE. Stripe's own dunning is configured in the dashboard
  // (TD-472); a second copy of the retry schedule living here would drift from theirs within a
  // release. This is a record, not a mechanism.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS billing_failures (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      stripe_event_id TEXT UNIQUE,
      stripe_invoice_id TEXT,
      stripe_subscription_id TEXT,
      stripe_customer_id TEXT,
      amount_due NUMERIC,
      currency TEXT,
      attempt_count INTEGER,
      next_attempt_at TIMESTAMP,
      failure_code TEXT,
      failure_message TEXT,
      billing_reason TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_billing_failures_user ON billing_failures(user_id, created_at DESC)');
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
// getOrCreateCanonicalVersion: the campaign's canonical version row, created if absent.
// The boot migration makes one for every campaign that exists, so this is the path for a campaign
// created SINCE the last boot. Reads before it writes, so two concurrent callers cannot both insert
// past idx_campaign_versions_canonical -- and if one loses that race the catch re-reads rather than
// failing the request.
async function getOrCreateCanonicalVersion(db, campaignId) {
  const ex = await db.prepare('SELECT id FROM campaign_versions WHERE campaign_id = ? AND is_canonical').get(campaignId);
  if (ex) return ex.id;
  try {
    const r = await db.prepare(
      "INSERT INTO campaign_versions (campaign_id, user_id, name, is_canonical, created_at) VALUES (?, NULL, 'Canonical', true, CURRENT_TIMESTAMP)"
    ).run(campaignId);
    return r.lastInsertRowid;
  } catch (e) {
    const again = await db.prepare('SELECT id FROM campaign_versions WHERE campaign_id = ? AND is_canonical').get(campaignId);
    if (again) return again.id;
    throw e;
  }
}

// v3.0.456 -- STAMPS version_id AT CREATION (TD-246). Stage 1 backfilled every existing fork on
// boot, which was enough while nothing read the column. It is not enough now: a session created
// between two boots would hold a canonical fork belonging to no version, and every book that
// falls through to it would find nothing. A fork must belong to a version the moment it exists.
async function getOrCreateDmFork(db, sessionId, dmUserId) {
  const existing = await db.prepare(
    "SELECT id, version_id FROM session_forks WHERE session_id = ? AND role = 'dm'"
  ).get(sessionId);
  const srow = await db.prepare('SELECT campaign_id FROM sessions WHERE id = ?').get(sessionId);
  const cvId = srow ? await getOrCreateCanonicalVersion(db, srow.campaign_id) : null;
  if (existing) {
    // Self-healing: a fork that predates this and was never stamped gets stamped on first touch.
    if (!existing.version_id && cvId) {
      await db.prepare('UPDATE session_forks SET version_id = ? WHERE id = ?').run(cvId, existing.id);
    }
    return existing.id;
  }
  const r = await db.prepare(
    "INSERT INTO session_forks (session_id, user_id, role, version_id, created_at) VALUES (?, ?, 'dm', ?, ?)"
  ).run(sessionId, dmUserId, cvId, new Date().toISOString());
  return r.lastInsertRowid;
}

// versionStyleDefaults: the STYLE a version carries, taken from the forks it already holds.
//
// THE THREE FIELDS ARE THE VERSION'S IDENTITY. "Pen and Ink with dark and grim narration" is a
// statement about a BOOK, not about one session -- Ian, 2026-08-06: three versions of session one,
// then session two, and each version should default to its own art and narration.
//
// PER FIELD, NOT PER ROW. The most recent fork that has an ART style may not be the most recent
// fork that has a NARRATION style, so each is resolved on its own. One row would silently drop a
// setting the version genuinely holds.
//
// NOT the same as the old campaign-wide inheritance it replaces, which keyed on sf.user_id: with
// three versions of one session all owned by one person and all sharing a session date, that query
// took an ARBITRARY row and handed its style to every version alike. The mechanism whose whole
// purpose was keeping styles consistent was homogenising the versions that exist to differ.
// v3.0.468 -- EXCLUDES THE SESSION BEING BRANCHED (TD-272), and that omission is the whole bug.
//
// This runs AFTER the new fork is inserted, so the new fork is already IN the version -- and with
// the latest session date, it won the ORDER BY. The INSERT populates it by copying from the SOURCE
// (session two's canonical), so the query found the canonical's value ON THE NEW ROW and wrote it
// back over itself. A no-op that looks exactly like a failure.
//
// WHY ART APPEARED TO WORK AND NARRATION DID NOT, which is what named the bug: narrative_style IS
// set on a canonical fork, so the new row had one and won. art_style_override is usually NULL there
// (art comes from sessions.art_style instead), so the IS NOT NULL filter skipped the new row and it
// fell through to the version's earlier session correctly. It worked by accident, on one field.
//
// versionPriorCharacterLooks, written one build later, excludes the session and requires an earlier
// date. This is the same rule and should have been the same shape.
async function versionStyleDefaults(db, versionId, sessionId) {
  const out = { art_style_override: null, narrative_style: null, narrative_verbosity: null };
  if (!versionId) return out;
  let before = null;
  if (sessionId) {
    const here = await db.prepare('SELECT session_date FROM sessions WHERE id = ?').get(sessionId);
    if (here) before = here.session_date;
  }
  const keys = Object.keys(out);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const r = await db.prepare(
      'SELECT sf.' + k + ' AS v FROM session_forks sf JOIN sessions s ON s.id = sf.session_id ' +
      'WHERE sf.version_id = ? AND sf.' + k + " IS NOT NULL AND sf." + k + " <> '' " +
      (sessionId ? 'AND sf.session_id <> ? ' : '') +
      (before ? 'AND s.session_date < ? ' : '') +
      'ORDER BY s.session_date DESC, s.created_at DESC, sf.id DESC LIMIT 1'
    ).get([versionId].concat(sessionId ? [sessionId] : []).concat(before ? [before] : []));   // array form: the wrapper flattens (args.flat()); .apply(null,...) works only by accident of get() not reading `this`
    if (r && r.v) out[k] = r.v;
  }
  return out;
}

// versionPriorCharacterLooks: how each character LOOKED at the end of this version's most recent
// EARLIER session. Returns { <character_id>: { prompt, reference_url } }.
//
// WHY THIS EXISTS. Ian, 2026-08-06: "you go to a new session, make a fork of that session using a
// pre-existing version. If you never hit Generate Story ... and go right to Generate Images and
// Generate Narrative, you will be using images of characters from a DIFFERENT version."
//
// That was exactly right. A branch copies session_characters from the SOURCE fork -- session two's
// CANONICAL -- and normal panels generate from that row's reference_url. So Zara breaks a horn in
// Watercolor session one, you add session two to Watercolor, press Generate, and she has both horns
// again, silently, because the row came from the Story Master's book. Nothing errors; the pictures
// are just wrong, and the user need never run anything that would correct it.
//
// PER CHARACTER, and MOST RECENT FIRST. A version that has held four sessions may have last seen a
// character in the second, so the newest row wins per character rather than one whole fork winning.
// A character this version has never carried simply is not in the map, and the canonical's look --
// already copied from the source fork -- stands. That is the same fallthrough as everywhere else.
//
// Ordered by session_date then fork id, and EXCLUDING the session being branched, because a version
// carries a look FORWARD; the session itself has not happened yet in that version.
async function versionPriorCharacterLooks(db, versionId, sessionId) {
  const out = {};
  if (!versionId || !sessionId) return out;
  const here = await db.prepare('SELECT session_date FROM sessions WHERE id = ?').get(sessionId);
  if (!here) return out;
  const rows = await db.prepare(
    'SELECT sc.character_id, sc.prompt, sc.reference_url, sc.change_note, sc.change_detail, ' +
    '       sc.change_flag, sc.change_status, sc.change_moment_index ' +
    'FROM session_characters sc ' +
    'JOIN session_forks sf ON sf.id = sc.fork_id ' +
    'JOIN sessions s ON s.id = sf.session_id ' +
    'WHERE sf.version_id = ? AND s.session_date < ? AND sc.session_id <> ? ' +
    'ORDER BY s.session_date ASC, sf.id ASC'
  ).all(versionId, here.session_date, sessionId);
  // Ascending, then overwrite: the LAST row for a character is the most recent, and this needs no
  // per-character sub-select.
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.reference_url && !r.prompt) continue;
    out[r.character_id] = { prompt: r.prompt || null, reference_url: r.reference_url || null };
  }
  return out;
}

// versionsForCampaign: every version a viewer may SELECT in this campaign, with the per-session
// state the dropdown needs.
//
// VISIBILITY. The canonical is visible to everyone. Your own versions are always visible. Someone
// else's is visible once ANY of its forks is Ready -- a version is not a visibility unit, Draft and
// Ready stay on the fork, and on the sessions where that version is still draft a viewer falls
// through to the canonical exactly as they would for a session it never branched.
//
// The owner name travels with every row because a NAME DOES NOT IDENTIFY A VERSION (TD-247): on
// The Strangers four different members each hold one called "Original".
async function versionsForCampaign(db, campaignId, viewerUserId, sessionId) {
  const rows = await db.prepare(
    'SELECT v.id, v.user_id, v.name, v.is_canonical, u.name AS owner_name, u.email AS owner_email ' +
    'FROM campaign_versions v LEFT JOIN users u ON u.id = v.user_id ' +
    'WHERE v.campaign_id = ? ORDER BY v.is_canonical DESC, v.id ASC'
  ).all(campaignId);
  const dmRow = await db.prepare("SELECT user_id FROM campaign_members WHERE campaign_id = ? AND role = 'dm' LIMIT 1").get(campaignId);
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i];
    const mine = !v.is_canonical && String(v.user_id) === String(viewerUserId);
    const forks = await db.prepare(
      'SELECT id, session_id, player_access_status FROM session_forks WHERE version_id = ?'
    ).all(v.id);
    const anyReady = forks.some(function (f) { return f.player_access_status === 'ready'; });
    if (!v.is_canonical && !mine && !anyReady) continue;
    const here = sessionId ? forks.filter(function (f) { return String(f.session_id) === String(sessionId); })[0] : null;
    const owner = v.is_canonical
      ? 'Story Master'
      : (mine ? 'You' : (v.owner_name || v.owner_email || 'Player'));
    // Ian, 2026-08-06: the OWNER may rename any version they own -- including the canonical, which
    // belongs to whoever holds the dm flag -- and "we always just put Canonical next to the name".
    // So the tag is a TAG, not the name: rename it "The Official Chronicle" and it still reads as
    // the canonical to every member who falls through to it. Suppressed when the name already IS
    // Canonical, so the default does not render as "Canonical (Canonical)".
    const tag = (v.is_canonical && String(v.name) !== 'Canonical') ? ' (Canonical)' : '';
    out.push({
      version_id: v.id,
      name: v.name,
      is_canonical: !!v.is_canonical,
      is_mine: mine,
      owner_user_id: v.is_canonical ? (dmRow ? dmRow.user_id : null) : v.user_id,
      owner_label: owner,
      label: owner + ' \u2014 ' + v.name + tag,
      session_count: forks.length,
      // For the session on screen: does this version have its OWN representation here, or is it
      // borrowing the canonical? The dropdown says which, because "the fork is the version's
      // representation on this session" and "there is no representation here" are different states.
      fork_id: here ? here.id : null,
      here: here ? 'own' : 'canonical',
      status: here ? here.player_access_status : null
    });
  }
  return out;
}

// getDmForkId: id of the session's DM (canonical) fork, or null. Read-only.
// v3.0.445 -- ONE RESOLVER FOR "WHICH VERSION AM I ACTING ON" (TD-194).
// There were THREE copies of this -- sessions.js, narrative.js and a role branch inside images.js --
// all written when a person could hold exactly one version of a session, and all answering the same
// way: Story Master gets the canonical, player gets their own. With several versions that answer is
// wrong in the same way three times over, and it was found three times over, one test cycle each.
// The rule: the version named by the REQUEST, checked by OWNERSHIP against the fork row, which is
// what Ian asked for -- the logged-in user id matched against the fork's user_id. A Story Master may
// also act on the canonical even if they do not own that row, because the campaign role confers it
// and the row can change hands on a handover.
// Returns null when the caller asked for a version that is not theirs. Callers must treat null as
// REFUSE, never as "fall back to something else" -- silently writing to a different version than the
// one on screen is the whole failure this replaces.
async function resolveActingFork(db, sessionId, userId, role, requestedForkId) {
  if (requestedForkId) {
    const want = await db.prepare('SELECT id, user_id, role FROM session_forks WHERE id = ? AND session_id = ?')
      .get(requestedForkId, sessionId);
    if (!want) return null;
    if (String(want.user_id) === String(userId)) return want.id;
    if (role === 'dm' && want.role === 'dm') return want.id;
    return null;
  }
  if (role === 'dm') return await getDmForkId(db, sessionId);
  const f = await db.prepare("SELECT id FROM session_forks WHERE session_id = ? AND user_id = ? ORDER BY id ASC").get(sessionId, userId);
  return f ? f.id : null;
}
// The version a request is about: ?fork_id= on a read, fork_id in the body on a write.
function requestedForkIdOf(req) {
  const q = req && req.query && req.query.fork_id;
  const b = req && req.body && req.body.fork_id;
  const v = (q != null && q !== '') ? q : ((b != null && b !== '') ? b : null);
  return v ? Number(v) : null;
}
async function getDmForkId(db, sessionId) {
  const f = await db.prepare("SELECT id FROM session_forks WHERE session_id = ? AND role = 'dm'").get(sessionId);
  return f ? f.id : null;
}

// ---------------------------------------------------------------------------------------------
// CAMPAIGN VERSIONS -- the read side (TD-242 stage 2a, v3.0.454).
//
// ONE PLACE. TD-194 cost thirteen builds because "which version am I acting on" was written down
// in twelve places, each correct while a person could hold exactly one version. The book side gets
// the rule ONCE, here, and the routes call it. The apply script refuses a build in which any route
// resolves a book fork for itself.
// ---------------------------------------------------------------------------------------------

// The version a request is about: ?as_version= on a read, as_version in the body on a write.
// Deliberately shaped like requestedForkIdOf above -- same idea, one level up.
function requestedVersionIdOf(req) {
  const q = req && req.query && req.query.as_version;
  const b = req && req.body && req.body.as_version;
  const v = (q != null && q !== '') ? q : ((b != null && b !== '') ? b : null);
  const n = v ? Number(v) : null;
  return (n && !isNaN(n)) ? n : null;
}

async function getVersionRow(db, versionId) {
  if (!versionId) return null;
  return await db.prepare(
    'SELECT id, campaign_id, user_id, name, is_canonical FROM campaign_versions WHERE id = ?'
  ).get(versionId);
}

// OWNERSHIP OF THE CANONICAL IS DERIVED, NEVER STORED. Ian, 2026-08-06: "the Canonical version is
// owned by whoever has the dm flag on the campaign but access to it is shared to the members."
// So the canonical row carries user_id NULL and the answer comes from campaign_members. A second
// stored copy would be free to drift, and it would go stale the first time a campaign changes hands.
// ownsBookVersion: does this user own the version whose book is on screen?
//
// v3.0.622 -- EXTRACTED, not copied. This test was written out longhand inside the my-book-meta PUT,
// and TD-401/402/405 needed it in three more places (archive a title, restore one, retouch one). Four
// hand-written copies of a permission check is how one of them ends up disagreeing with the other
// three, and the one that disagrees is the one that lets a write through.
//
// A version id of null/0 means there is no version scope to test, which is NOT a refusal -- the
// my-book-meta fork check has already run by then and is the thing guarding that case.
async function ownsBookVersion(db, uid, bookVersionId) {
  if (!bookVersionId) return true;
  const vw = await db.prepare('SELECT id, campaign_id, user_id, is_canonical FROM campaign_versions WHERE id = ?').get(bookVersionId);
  let owner = null;
  try { owner = vw ? await versionOwnerUserId(db, vw) : null; } catch (e) { owner = null; }
  return owner != null && String(owner) === String(uid);
}

async function versionOwnerUserId(db, version) {
  if (!version) return null;
  if (!version.is_canonical) return version.user_id;
  const dm = await db.prepare(
    "SELECT user_id FROM campaign_members WHERE campaign_id = ? AND role = 'dm' LIMIT 1"
  ).get(version.campaign_id);
  return dm ? dm.user_id : null;
}

// resolveBookVersion: turn a request into the book context the assembly sites need.
//
// Returns { versionId, version, asUser } or null when no version was named (every caller then
// keeps its existing as_user path untouched, which is why this stage changes no behaviour).
//
// asUser IS NOT THE VERSION OWNER FOR A CANONICAL VERSION -- it is null. That looks like an
// omission and is not: effectiveIncludeMap(campaignId, null) means "the Story Master's own book,
// read from sessions.novel_include", while passing the DM's user id would read session_includes
// rows instead and quietly assemble a different book. Preserving that distinction is the whole
// reason this returns asUser rather than letting each site derive it.
async function resolveBookVersion(db, campaignId, req) {
  const versionId = requestedVersionIdOf(req);
  if (!versionId) return null;
  const version = await getVersionRow(db, versionId);
  if (!version) return null;
  if (String(version.campaign_id) !== String(campaignId)) return null;
  const asUser = version.is_canonical ? null : version.user_id;
  return { versionId: version.id, version: version, asUser: asUser };
}

// prefsVersionId: the version id used to SCOPE BOOK PREFS AND INCLUDES.
//
// A CANONICAL VERSION MAPS TO 0, NOT TO ITS OWN ID. The canonical IS the base book -- every prefs
// and includes row that exists today belongs to it -- so mapping it to 0 means this whole stage
// moves no data and cannot touch a Story Master's approved layout. Only a NAMED version gets rows.
function prefsVersionId(bv) {
  if (!bv || !bv.version) return 0;
  return bv.version.is_canonical ? 0 : bv.versionId;
}

// bookPrefsScope: chooser + fork + version for a book request, in ONE place. This replaced five
// copies of the same three-line derivation in pdf.js and two more in campaigns.js.
async function bookPrefsScope(db, req, campaignId) {
  const bv = await resolveBookVersion(db, campaignId, req);
  const asUser = (bv && bv.asUser) || (req.query && req.query.as_user ? Number(req.query.as_user) : null);
  // v3.0.478 -- THE CANONICAL'S PREFS BELONG TO THE STORY MASTER, NOT TO WHOEVER IS LOOKING (TD-280).
  //
  // resolveBookVersion returns asUser = NULL for a canonical version, and that is right for the
  // two things it was written for: effectiveIncludeMap(campaignId, null) means "read
  // sessions.novel_include", and bookForkForSession falls through to the DM fork anyway. It is
  // WRONG here. `fork` identifies whose PREFS ROW to read, and null made it default to the viewer
  // -- so a member opening the canonical read their OWN empty base row, inherit never fired
  // (chooserId === forkId), and the covers fell through to the campaign image. It looked correct
  // to Ian as the Story Master only because HE is the right fork by coincidence.
  //
  // Derived from campaign_members, never stored: same rule as everywhere else in this feature, and
  // it follows a Story Master handover for free.
  let forkOwner = asUser;
  if (bv && bv.version && bv.version.is_canonical) {
    try { forkOwner = await versionOwnerUserId(db, bv.version); } catch (e) { forkOwner = asUser; }
  }
  const fork = forkOwner || (req.session && req.session.userId) || null;
  const chooser = (req.session && req.session.userId) || fork;
  return { chooser: chooser, fork: fork, versionId: prefsVersionId(bv), bookVersionId: bv ? bv.versionId : null, asUser: bv ? bv.asUser : asUser };
}

// bookForkForSession: WHICH FORK OF ONE SESSION A BOOK READS. This replaced five byte-identical
// copies of the same lookup -- four in pdf.js, one in sessions.js.
//
// THE FALLTHROUGH, stated once: a version with no fork for this session reads the CANONICAL. That
// is what makes a version cheap -- branch one session, leave the rest alone, and the book is the
// Story Master's everywhere you did not touch it.
//
// NOTE ON READY: this gates on EXISTENCE, not on player_access_status, because the as_user book
// path it replaces never had a Ready gate either and adding one here would silently change which
// books assemble today. Whether a reader may build a book from someone else's DRAFT version is a
// route-level product question -- see TD-249 -- and it is not answered by a helper.
async function bookForkForSession(db, sessionId, opts) {
  const o = opts || {};
  if (o.versionId) {
    const f = await db.prepare('SELECT id FROM session_forks WHERE session_id = ? AND version_id = ?')
      .get(sessionId, o.versionId);
    if (f) return f.id;
    return await getDmForkId(db, sessionId);
  }
  if (o.asUser) {
    const pf = await db.prepare(
      "SELECT id FROM session_forks WHERE session_id = ? AND user_id = ? AND role = 'player' ORDER BY id ASC"
    ).get(sessionId, o.asUser);
    if (pf) return pf.id;
  }
  return await getDmForkId(db, sessionId);
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
    // v3.0.439 -- ORDER BY, because the unique constraint that used to guarantee one row is gone.
    "SELECT id FROM session_forks WHERE session_id = ? AND user_id = ? AND role = 'player' ORDER BY id ASC"
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
// v3.0.455 -- versionId is the FOURTH argument and defaults to 0, so every existing caller keeps
// its exact behaviour. A named version's own rows WIN over the base rows; where it has expressed no
// opinion it inherits the base book's choice, which is the same fallthrough the forks use.
async function effectiveIncludeMap(db, campaignId, ownerUserId, versionId) {
  const vid = Number(versionId) || 0;
  const isOn = function(v) { return !(v === false || v === 0 || v === 'f' || v === 'false'); };
  const sessions = await db.prepare('SELECT id, novel_include FROM sessions WHERE campaign_id = ?').all(campaignId);
  const map = {};
  if (!ownerUserId) {
    for (let i = 0; i < sessions.length; i++) { map[sessions[i].id] = isOn(sessions[i].novel_include); }
    return map;
  }
  const rows = await db.prepare(
    'SELECT si.session_id, si.include, si.version_id FROM session_includes si JOIN sessions s ON s.id = si.session_id WHERE si.user_id = ? AND s.campaign_id = ? AND si.version_id IN (0, ?)'
  ).all(ownerUserId, campaignId, vid);
  const ov = {};
  // Base rows first, then the version's own on top -- so the version wins wherever it has a row.
  for (let i = 0; i < rows.length; i++) { if (Number(rows[i].version_id) === 0) ov[rows[i].session_id] = isOn(rows[i].include); }
  for (let i = 0; i < rows.length; i++) { if (Number(rows[i].version_id) === vid && vid !== 0) ov[rows[i].session_id] = isOn(rows[i].include); }
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
  const p = await getForkBookPrefs(db, ownerUserId, ownerUserId, campaignId);
  if (!p || (!p.cover_image_url && !p.back_cover_image_url && !p.title_image_url && !p.book_title)) return null;
  return {
    cover_image_url: p.cover_image_url || null,
    back_cover_image_url: p.back_cover_image_url || null,
    title_image_url: p.title_image_url || null,
    book_title: p.book_title || null
  };
}

// Fork-view book prefs helpers. get: returns the prefs JSON for (chooser, fork, campaign);
// if empty and chooser != fork, inherit from the fork owner's own (fork, fork) slot so a
// first-time overlay starts from the member's look. set: shallow-merges a patch (each
// top-level key -- covers, title_color, layout_opts, etc. -- is written whole) and upserts.
// v3.0.455 -- opts.versionId scopes both. 0 (or absent) is the BASE book, which is every row that
// exists today and is what the canonical version reads and writes.
//
// READ ORDER, and each step earns its place:
//   1. this version's own row                     -- what it has chosen
//   2. the BASE row for the same (chooser, fork)  -- a new version starts from the book it branched
//   3. the fork owner's own slot, same two steps  -- the pre-existing overlay inheritance
// Step 2 is why creating a version does not produce an empty book. It is a READ-time fallback, not
// a copy: the base row is never written by a version, so the book it branched from cannot change
// under it by accident.
async function getForkBookPrefs(db, chooserId, forkId, campaignId, opts) {
  opts = opts || {};
  const vid = Number(opts.versionId) || 0;
  function parse(row) { if (row && row.prefs) { try { return JSON.parse(row.prefs) || {}; } catch (e) {} } return null; }
  async function at(ch, fk, v) {
    return parse(await db.prepare('SELECT prefs FROM fork_book_prefs WHERE chooser_user_id = ? AND fork_user_id = ? AND campaign_id = ? AND version_id = ?').get(ch, fk, campaignId, v));
  }
  // v3.0.651 -- TD-440. A CROSS-USER READ GOES STRAIGHT TO THE OWNER, AND SKIPS THE OVERLAY.
  //
  // Ian, 2026-08-12, as Story Master on a member version with everything deliberately switched off:
  // "It is not loading up that Members layout options... Stuff was selected that should not have
  // been."
  //
  // WHAT IT WAS FINDING. The chain used to try (viewer, owner) FIRST, and only fall through to
  // (owner, owner) when nothing was there. A (viewer, owner) row is the OVERLAY that a Story Master
  // could write before v3.0.575 -- cover and title only, never the layout. 575 removed the ability to
  // WRITE one and deleted none of the rows already written, so every such row has been shadowing its
  // owner settings ever since, for every reader that inherits.
  //
  // NOTHING CAN CREATE ONE ANY MORE. v3.0.575 refuses a cross-fork write, and the v3.0.650 curation
  // carve-out deliberately writes as the OWNER so the Story Master edits land in the row the member
  // reads. So a (viewer, owner) row can now only be legacy, and reading one is always wrong.
  //
  // AND IT HAD TO BE FIXED HERE. Fourteen call sites read these prefs and every one passes the viewer
  // as chooser and the owner as fork -- the novel render, the print interior, the cover, publish, the
  // title target, the member prefs route and the book-meta GET. Fourteen patches would have been
  // fourteen chances to miss one; this is the question they are all asking, so this is where it is
  // answered.
  //
  // inherit:false IS UNTOUCHED, deliberately. Those callers -- the optimize save and its readers --
  // are not asking "what are this book settings", they are addressing one specific (chooser, fork)
  // slot on purpose. Whether the approved layout should follow the owner under curation is a real
  // question and a separate one; it is logged rather than answered inside a read fix.
  let p;
  if (opts.inherit && chooserId !== forkId) {
    if (vid !== 0) { p = await at(forkId, forkId, vid); if (p) return p; }
    p = await at(forkId, forkId, 0);
    return p || {};
  }
  p = await at(chooserId, forkId, vid);
  if (p) return p;
  if (vid !== 0) { p = await at(chooserId, forkId, 0); if (p) return p; }
  return {};
}
// v3.0.578 -- opts.fillOnly INVERTS THE MERGE, and it exists because of a bug this function's
// shape makes inevitable. This is a READ-MODIFY-WRITE over one JSON blob with an await in the
// middle, so two requests in flight together interleave and the later WRITE wins with the earlier
// READ's snapshot. That was harmless while the Prep panel had exactly one writer. v3.0.575 added a
// second -- the first-load materialise -- and a subtitle typed while it was in flight was written,
// then silently overwritten by a snapshot taken before it existed.
// FILL-ONLY IS WHAT A MATERIALISE ACTUALLY MEANS: write these defaults only where nothing is set.
// Under it the stored row always wins, so a materialise cannot clobber a real edit NO MATTER HOW
// THE TWO REQUESTS INTERLEAVE -- which is a property of the operation rather than of the timing,
// and therefore does not have to be got right twice.
// An explicit null in the patch is still a value under a normal write; under fillOnly the current
// row simply wins, including when the current value is an empty string (a deliberately cleared
// subtitle is SET, not absent).
async function setForkBookPrefs(db, chooserId, forkId, campaignId, patch, versionId, opts) {
  const vid = Number(versionId) || 0;
  const cur = await getForkBookPrefs(db, chooserId, forkId, campaignId, { inherit: true, versionId: vid });
  const merged = (opts && opts.fillOnly)
    ? Object.assign({}, patch || {}, cur)
    : Object.assign({}, cur, patch || {});
  const json = JSON.stringify(merged);
  // ON CONFLICT names fork_book_prefs_scope_key's exact column list. If that constraint is ever
  // changed, THIS STATEMENT MUST CHANGE IN THE SAME COMMIT -- dropping a constraint invalidates
  // every ON CONFLICT that targets it, which is how v3.0.439 stopped staging booting.
  await db.prepare(
    'INSERT INTO fork_book_prefs (chooser_user_id, fork_user_id, campaign_id, version_id, prefs, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ' +
    'ON CONFLICT (chooser_user_id, fork_user_id, campaign_id, version_id) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = CURRENT_TIMESTAMP'
  ).run(chooserId, forkId, campaignId, vid, json);
  return merged;
}

// =====================================================================================================
// v3.0.698 -- TD-497. AN EMPTY COVER HAD TWO MEANINGS, AND ONE BUTTON NEEDED THEM SEPARATED.
// =====================================================================================================
//
// Ian, 2026-08-18: "We need a way to clear all three cover images and just let the front and back
// covers be the dark brown that is there now."
//
// Nine places said the same thing: no cover chosen means use the campaign tile picture. That is
// right for a book nobody has set up, and it makes Remove impossible -- the write lands, the next
// read puts the picture straight back, and the button looks broken while the server is the one
// doing it. Empty meant BOTH "never chosen" and "deliberately none", which is the TD-443 fault in
// a different field.
//
// THE THIRD STATE WAS ALREADY IN THE STORAGE AND NOBODY WAS READING IT. fork_book_prefs is a JSON
// blob, so a key can be ABSENT as well as empty, and the two are already written apart:
//
//   key absent                  -- nothing has ever been chosen        -> the campaign picture
//   key present, falsy          -- chosen, then deliberately cleared   -> no cover
//   key present, truthy         -- that picture
//
// NO BACKFILL IS NEEDED, and that was measured rather than hoped for. prepMaterializeBookMeta
// writes cover_image_url ONLY when own_cover is truthy (`if (_bm.own_cover) _body.cover_image_url
// = _bm.own_cover;`), so a book that has never had a cover picked has never had the key written.
// Every existing row therefore already means what this function reads it as.
//
// ONE FUNCTION, because the alternative is the same three-line rule in three files -- and a rule
// spelled out per call site is a rule that will disagree with itself the first time one of them is
// edited. That is the derives-do-not-pair rule, and this is the shape it takes here.
function coverFromPrefs(prefs, campaignImageUrl) {
  var p = prefs || {};
  if (Object.prototype.hasOwnProperty.call(p, 'cover_image_url')) return p.cover_image_url || '';
  return campaignImageUrl || '';
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

module.exports = { coverFromPrefs, getDb, resolveActingFork, requestedForkIdOf, isPostgres, getOrCreateDmFork, getDmForkId, getViewableForkId, effectiveIncludeMap, effectiveBookMeta, getForkBookPrefs, setForkBookPrefs, getAppSettingInt, requestedVersionIdOf, getVersionRow, versionOwnerUserId, ownsBookVersion, resolveBookVersion, bookForkForSession, prefsVersionId, bookPrefsScope, getOrCreateCanonicalVersion, versionsForCampaign, versionStyleDefaults, versionPriorCharacterLooks };
