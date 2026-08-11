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
  bookPrefsScope, ownsBookVersion, getForkBookPrefs, setForkBookPrefs
} = require('../database/db');

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
    momentId: t && t.momentId ? Number(t.momentId) : null
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

  // TD-422 stage two. The session branch reads and writes the establishing MOMENT -- which already
  // carries fork_id, so nothing new has to be stored to make a chapter title fork with its version.
  return { error: 'Chapter titles are not built yet. This build only knows how to title a book.' };
}

module.exports = { resolveTitleTarget, targetFromRequest, NOT_YOURS };
