// =====================================================================================================
// TITLE TARGET  --  one adapter for "the thing a built title belongs to"  (TD-422)
// =====================================================================================================
// Until v3.0.636 every part of the Title Builder said "the book's title on this version" in its own
// words. resolveOwnBuiltTitle in routes/images.js and titleScope in routes/campaigns.js did the SAME
// three things -- resolve the book scope, prove the caller owns that version, read the prefs -- and
// differed only in the shape they handed back. Two copies of one idea.
//
// Ian wants chapter titles next: the Title Builder pointed at a session's opening image so a chapter
// can be titled with words instead of a scene. His instruction was "Don't copy the logic...
// Parameteritise it." This is that parameterisation, shipped on its own with the BOOK as its only
// caller and no behaviour change, so that if the Title Builder breaks it is this and nothing else.
//
// NEUTRAL FIELD NAMES ARE THE WHOLE POINT. Callers read and write { url, src, text, sub, prompt };
// only the book adapter below knows those are stored as built_title_url and friends in a version's
// prefs blob. A session target will store them somewhere else entirely -- on the establishing moment,
// which already carries fork_id -- and no route will need to know that.
//
// A SESSION TARGET IS NOT IMPLEMENTED HERE, AND SAYS SO. It would have been easy to write the branch
// now and leave it uncalled, but TD-419 is in the to-do precisely because a stub that looks like a
// feature outlives the memory of it being a stub: buildSessionHTML has carried `var _builtTitle = ''`
// for long enough that the handoff claims three cover surfaces where there are two. An explicit
// refusal is honest; a silent one is a trap.
const {
  bookPrefsScope, ownsBookVersion, getForkBookPrefs, setForkBookPrefs,
  resolveActingFork, requestedForkIdOf, getDmForkId
} = require('../database/db');
const { getCampaignRole } = require('../middleware/auth');

const NOT_YOURS = 'You are looking at someone else\u2019s version. Switch to your own version to change the title.';

// targetFromRequest: what the caller is pointing at, derived from the request as it always was.
//
// The body may name a target; absent one, it is the book -- which is every caller today, and is why
// this build changes no behaviour. A caller that names something else is refused rather than quietly
// treated as the book, because "I asked for a chapter and it edited the cover" is a worse failure
// than an error message.
function targetFromRequest(req, campaignId) {
  const t = (req.body && req.body.target) || null;
  const kind = t && t.kind ? String(t.kind) : 'book';
  return {
    kind: kind,
    campaignId: Number(campaignId),
    sessionId: t && t.sessionId ? Number(t.sessionId) : null,
    // The version of the SESSION being worked on. Absent, the caller's own fork is resolved.
    forkId: t && t.forkId ? Number(t.forkId) : null
  };
}

// resolveTitleTarget: prove the caller may change this target, and hand back a reader and a writer.
//
// Returns { error } or { kind, campaignId, current, write, scope }.
//   current: { url, src, text, sub, prompt, bookTitle }
//   write(patch): the same neutral names; only the keys present are written.
//
// The ownership question is answered HERE, once, for whatever the target turns out to be. Six routes
// used to ask it in their own words; the two that asked it about a version asked it identically and
// were still two places for it to be got wrong.
async function resolveTitleTarget(db, req, target) {
  const t = target || targetFromRequest(req, req.params && req.params.campaignId);

  if (t.kind === 'book') {
    const uid = req.session.userId;
    const sc = await bookPrefsScope(db, req, Number(t.campaignId));
    if (!(await ownsBookVersion(db, uid, sc.bookVersionId))) return { error: NOT_YOURS };
    const cur = await getForkBookPrefs(db, uid, sc.fork, t.campaignId, { inherit: true, versionId: sc.versionId });
    return {
      kind: 'book',
      campaignId: t.campaignId,
      scope: sc,
      current: {
        url: cur.built_title_url || '',
        src: cur.built_title_src || '',
        text: cur.built_title_text || '',
        sub: (cur.built_title_sub == null ? null : String(cur.built_title_sub)),
        prompt: cur.built_title_prompt || '',
        // WHAT THIS TARGET SHOULD DRAW, resolved here so /title-build stops trusting the body.
        // The comment above that route has claimed since v3.0.617 that the words are read
        // server-side; it read req.body.bookTitle. Harmless while the client was the only caller
        // and the client sent the right thing -- but it was never the guarantee it claimed, and a
        // chapter's words come from somewhere else entirely.
        words: { title: cur.book_title || '', subtitle: cur.subtitle || '' },
        prevUrl: cur.built_title_prev || '',
        prevSrc: cur.built_title_prev_src || '',
        bookTitle: cur.book_title || ''
      },
      // THE ONLY PLACE THAT KNOWS THE STORAGE NAMES. Undefined keys are left alone rather than
      // nulled, so a caller writing only the artwork cannot silently erase the words beside it.
      write: async function (patch) {
        const p = {};
        if (patch.url !== undefined) p.built_title_url = patch.url || null;
        if (patch.src !== undefined) p.built_title_src = patch.src || null;
        if (patch.text !== undefined) p.built_title_text = patch.text || null;
        if (patch.sub !== undefined) p.built_title_sub = (patch.sub === '' ? '' : (patch.sub || null));
        if (patch.prompt !== undefined) p.built_title_prompt = patch.prompt || null;
        if (patch.prevUrl !== undefined) p.built_title_prev = patch.prevUrl || null;
        if (patch.prevSrc !== undefined) p.built_title_prev_src = patch.prevSrc || null;
        const merged = await setForkBookPrefs(db, req.session.userId, sc.fork, t.campaignId, p, sc.versionId);
        // Answers in the NEUTRAL shape too. Handing the raw prefs blob back would put built_title_*
        // in the caller again, which is the leak this whole module exists to close.
        return {
          url: merged.built_title_url || '',
          src: merged.built_title_src || '',
          text: merged.built_title_text || '',
          sub: (merged.built_title_sub == null ? null : String(merged.built_title_sub)),
          prompt: merged.built_title_prompt || ''
        };
      }
    };
  }

  if (t.kind === 'session') return await sessionTarget(db, req, t);

  return { error: 'Unknown title target.' };
}

// =====================================================================================================
// THE SESSION TARGET  --  a chapter title, stored on the establishing moment  (TD-422 stage two)
// =====================================================================================================
// Ian: chapter titles, "SO they can title their chapters with words instead of a Picture."
//
// NOTHING NEW IS STORED. The opening title image is already a moment with kind='establishing', and
// moments already carry fork_id -- so "tied to the actual fork" is satisfied by writing where the
// opening image already lives, not by inventing a per-session-per-fork field. The artwork simply
// BECOMES that moment's image, which is why no renderer changes: every surface that draws a chapter
// opening already draws this row.
//
// THE WORDS ARE DERIVED, NOT COPIED. moments.title on that row is set to session.name when it is
// created, so a chapter title needs no stored name of its own and cannot drift from the session name
// the way a second copy would. built.text records only what the drawing actually SPELLED when it was
// drawn, which is the mismatch warning's question and nobody else's.
//
// THE MARKER MATTERS. Nothing else can tell a drawing-of-words from a scene, and the pill row's
// Retouch goes through the panel webhook path with a scene-shaped prompt. layout_meta.built_title is
// that marker: free-form JSON already on the row, already parsed for focal and crop_safe, no schema
// change. Its presence is what will route Retouch to the title path instead.
//
// THE SCENE PROMPT IS NEVER DISPLACED. moments.prompt and sessions.establishing_prompt both keep the
// scene text, so Regenerate draws the scene later if the reader changes their mind. That is the
// escape hatch, and the reason a chapter title needs no Remove of its own.
async function sessionTarget(db, req, t) {
  if (!t.sessionId) return { error: 'No session named for this chapter title.' };
  const uid = req.session.userId;

  const sess = await db.prepare('SELECT id, campaign_id, name FROM sessions WHERE id = ?').get(t.sessionId);
  if (!sess) return { error: 'Session not found.' };
  if (String(sess.campaign_id) !== String(t.campaignId)) return { error: 'That session is not in this campaign.' };

  // OWNERSHIP, through the resolver the generate path already uses. It returns null rather than
  // falling back, so a version that is not yours is a refusal and never a quiet redirect into
  // someone else's book -- which is the fault TD-194 was raised for.
  const role = await getCampaignRole(uid, sess.campaign_id);
  const asked = t.forkId || requestedForkIdOf(req);
  let forkId = await resolveActingFork(db, t.sessionId, uid, role, asked);
  if (!forkId && asked) return { error: 'That version is not yours to change.' };
  if (!forkId && role === 'dm') forkId = await getDmForkId(db, t.sessionId);
  if (!forkId) return { error: 'You do not have a version of this session to change.' };

  const est = await db.prepare(
    "SELECT * FROM moments WHERE session_id = ? AND fork_id = ? AND kind = 'establishing' ORDER BY id LIMIT 1"
  ).get(t.sessionId, forkId);

  let meta = {};
  try { meta = est && est.layout_meta ? (typeof est.layout_meta === 'object' ? est.layout_meta : JSON.parse(est.layout_meta)) : {}; }
  catch (e) { meta = {}; }
  const built = (meta && meta.built_title) || {};

  return {
    kind: 'session',
    campaignId: t.campaignId,
    sessionId: t.sessionId,
    forkId: forkId,
    momentId: est ? est.id : null,
    scope: { forkId: forkId, moment: est || null },
    current: {
      // The artwork IS the opening image -- but only when the marker says this row is a drawn title.
      // Without that test a scene would be handed to Retouch as though it were lettering.
      url: (built.url && est) ? (est.image || '') : '',
      src: built.src || '',
      text: built.text || '',
      sub: (built.sub === undefined ? null : built.sub),
      prompt: built.prompt || '',
      prevUrl: built.prevUrl || '',
      // v3.0.656 -- THE DRAFT. Artwork that has been built and paid for but not accepted. It is
      // reported alongside the live title so reopening the builder shows what you last drew,
      // whether or not you used it.
      draft: (meta && meta.built_title_draft) || null,
      prevSrc: built.prevSrc || '',
      // What the chapter is CALLED, read off the row rather than stored a second time.
      bookTitle: (est && est.title) || sess.name || '',
      // Ian: "use the Session Title as the title and leave the sub title blank." Read off the row
      // rather than stored, so renaming the session is the only way to change what a rebuild draws.
      words: { title: (est && est.title) || sess.name || '', subtitle: '' }
    },
    write: async function (patch) {
      // v3.0.639 -- BUILD A TITLE BEFORE ANY IMAGES EXIST, and the row is created here.
      //
      // Ian: "If they hit the button and make a title picture before they have generated any images...
      // then use that new image as the Opening scene image." Until the story is extracted there IS no
      // establishing moment, so the write had nowhere to land and refused.
      //
      // THE ROW IS BUILT FROM THE SAME COLUMNS routes/extract.js writes, in the same order and with
      // the same layout_meta shape -- prominence 5, centre focal, crop-safe, no group break -- so a
      // row created here and a row created by the pipeline are indistinguishable to every renderer.
      // A second shape for the same kind of row is how one of them ends up laid out differently.
      //
      // panel_order 0 and kind 'establishing' are what make it the OPENING. The scene prompt is left
      // NULL rather than invented: extract fills it when the story is generated, and a made-up prompt
      // here would be a scene description nobody wrote (see the Regenerate note above).
      let row = est;
      if (!row) {
        if (patch.url === undefined || !patch.url) return { error: 'There is nothing to put on this chapter yet.' };
        const now = new Date().toISOString();
        const created = await db.prepare(
          'INSERT INTO moments (session_id, fork_id, title, description, type, prompt, emphasis, shape, layout_meta, kind, panel_order, created_at, created_by) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(t.sessionId, forkId, (sess.name || 'Title Image'), '', null, null, null, 'wide',
              JSON.stringify({ prominence: 5, focal: 'center', crop_safe: true, group_break: false }),
              'establishing', 0, now, uid);
        row = await db.prepare('SELECT * FROM moments WHERE id = ?').get(created.lastInsertRowid);
        if (!row) return { error: 'Could not create the opening image row.' };
        try { meta = row.layout_meta ? (typeof row.layout_meta === 'object' ? row.layout_meta : JSON.parse(row.layout_meta)) : {}; }
        catch (e) { meta = {}; }
      }
      // v3.0.656 -- BUILD DOES NOT APPLY. TD-448.
      //
      // Ian, 2026-08-12: "Hold the write... if we do it this way when they open it back up again
      // the text image they just generated will be there. It just did not get used."
      //
      // A build used to land on the panel the instant it returned, so Cancel had nothing left to
      // cancel. Holding the write ENTIRELY would have been worse: a cancelled build would vanish
      // and the token with it. So the artwork is persisted -- as a DRAFT on the row -- and only
      // Done and Use promotes it. Nothing you paid for is lost; nothing reaches the book until
      // you say so.
      //
      // ONE DRAFT PER TARGET, deliberately. A second build replaces the first. Keeping every
      // attempt would be inventing a second archive beside the one that already exists.
      if (patch.draft) {
        const dNext = Object.assign({}, (meta && meta.built_title_draft) || {});
        ['url', 'src', 'text', 'sub', 'prompt'].forEach(function (k) {
          if (patch[k] === undefined) return;
          dNext[k] = (k === 'sub' && patch[k] === '') ? '' : (patch[k] || null);
        });
        const dMeta = Object.assign({}, meta);
        dMeta.built_title_draft = dNext;
        await db.prepare('UPDATE moments SET layout_meta = ? WHERE id = ?').run(JSON.stringify(dMeta), row.id);
        // The LIVE title is returned unchanged, because nothing about it moved.
        return {
          url: built.url || '', src: built.src || '', text: built.text || '',
          sub: (built.sub === undefined ? null : built.sub),
          prompt: built.prompt || '', draft: dNext
        };
      }
      // PROMOTE reuses the ordinary write below rather than repeating it. The draft becomes the
      // patch, so the marker, the image, the displaced-picture undo slot and the returned shape
      // are all produced by one path -- the path that is already tested.
      var _promoted = false;
      if (patch.promote) {
        const d = (meta && meta.built_title_draft) || null;
        if (!d || !d.url) return { error: 'There is nothing drawn to use yet.' };
        patch = { url: d.url, src: d.src, text: d.text, sub: d.sub, prompt: d.prompt,
                  prevUrl: built.url || '', prevSrc: built.src || '' };
        _promoted = true;
      }
      const next = Object.assign({}, built);
      ['url', 'src', 'text', 'sub', 'prompt', 'prevUrl', 'prevSrc'].forEach(function (k) {
        if (patch[k] === undefined) return;
        next[k] = (k === 'sub' && patch[k] === '') ? '' : (patch[k] || null);
      });
      const cleared = patch.url !== undefined && !patch.url;
      const nextMeta = Object.assign({}, meta);
      // CLEARING THE TITLE CLEARS THE MARKER, or the row would go on claiming to be lettering after
      // Regenerate has put a scene back on it -- and Retouch would keep routing to the title path.
      if (cleared) delete nextMeta.built_title; else nextMeta.built_title = next;
      // A promoted draft is spent. Clearing the title clears any draft with it -- the panel is
      // being emptied, and leaving a draft behind would make Remove look as though it had failed
      // the next time the modal opened.
      if (_promoted || cleared) delete nextMeta.built_title_draft;
      // v3.0.653 -- TD-445. ARM REVERT WITH WHATEVER THE TITLE DISPLACED.
      //
      // Ian, 2026-08-12, on v3.0.652: "it just pulled down a picture from the title builder and I
      // did not get the revert button on the panel."
      //
      // moments.revert_image is the one-deep undo every other image path arms -- retouch and
      // single regenerate both do it in the fal webhook. The title write never did, so building a
      // title over an opening picture overwrote the ONLY reference to that picture and left the
      // panel with nothing to go back to. The scene PROMPT survives, so Regenerate could redraw
      // something similar, but that costs a token and returns a different picture. This returns
      // the actual one.
      //
      // ARMED ONLY WHEN SOMETHING IS ACTUALLY DISPLACED. Rebuilding a title over a title would
      // otherwise push the scene out of the undo slot and replace it with the previous title, so
      // the row would forget the picture after two builds. The FIRST displacement is the one worth
      // keeping, which is why an existing revert_image is never overwritten here.
      // Clearing a title restores nothing by itself: Revert is the control that does that, and it
      // is the reader who decides.
      var _displaced = (row.image && !row.revert_image && patch.url) ? row.image : null;
      if (patch.url !== undefined) {
        if (_displaced) {
          await db.prepare('UPDATE moments SET image = ?, layout_meta = ?, revert_image = ?, revert_img_w = ?, revert_img_h = ? WHERE id = ?')
            .run(patch.url || null, JSON.stringify(nextMeta), _displaced, row.img_w || null, row.img_h || null, row.id);
        } else {
          await db.prepare('UPDATE moments SET image = ?, layout_meta = ? WHERE id = ?')
            .run(patch.url || null, JSON.stringify(nextMeta), row.id);
        }
      } else {
        await db.prepare('UPDATE moments SET layout_meta = ? WHERE id = ?').run(JSON.stringify(nextMeta), row.id);
      }
      return {
        url: cleared ? '' : (next.url || ''),
        src: next.src || '',
        text: next.text || '',
        sub: (next.sub === undefined ? null : next.sub),
        prompt: next.prompt || '',
        // v3.0.653 -- what the panel Revert pill will restore, if anything. The client patches the
        // moment it is holding rather than re-fetching, so without this the pill would not appear
        // until the next load even though the slot was armed correctly.
        revertImage: _displaced || row.revert_image || ''
      };
    }
  };
}

module.exports = { resolveTitleTarget, targetFromRequest, sessionTarget, NOT_YOURS };
