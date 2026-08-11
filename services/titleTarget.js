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
      prevSrc: built.prevSrc || '',
      // What the chapter is CALLED, read off the row rather than stored a second time.
      bookTitle: (est && est.title) || sess.name || '',
      // Ian: "use the Session Title as the title and leave the sub title blank." Read off the row
      // rather than stored, so renaming the session is the only way to change what a rebuild draws.
      words: { title: (est && est.title) || sess.name || '', subtitle: '' }
    },
    write: async function (patch) {
      if (!est) return { error: 'This chapter has no opening image row yet.' };
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
      if (patch.url !== undefined) {
        await db.prepare('UPDATE moments SET image = ?, layout_meta = ? WHERE id = ?')
          .run(patch.url || null, JSON.stringify(nextMeta), est.id);
      } else {
        await db.prepare('UPDATE moments SET layout_meta = ? WHERE id = ?').run(JSON.stringify(nextMeta), est.id);
      }
      return {
        url: cleared ? '' : (next.url || ''),
        src: next.src || '',
        text: next.text || '',
        sub: (next.sub === undefined ? null : next.sub),
        prompt: next.prompt || ''
      };
    }
  };
}

module.exports = { resolveTitleTarget, targetFromRequest, sessionTarget, NOT_YOURS };
