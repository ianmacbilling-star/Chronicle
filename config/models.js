// Single source of truth for the AI / image models Campaignia calls. Swap a
// model via env var (AI_MODEL / HELP_MODEL / LAYOUT_MODEL) or by editing a default here in ONE
// place -- important if a model is ever repriced, renamed, or decommissioned.
// The active image model is chosen at runtime from app_settings 'image_model';
// the actual fal.ai endpoint strings live here so a swap is a single edit rather
// than a hunt across files.

const TEXT_MODEL = process.env.AI_MODEL || 'claude-sonnet-4-6';
const HELP_MODEL = process.env.HELP_MODEL || 'claude-haiku-4-5-20251001';
// AI layout-optimization vision pass ('Optimize Layout'). Overridable in Railway via
// LAYOUT_MODEL; defaults to the same Sonnet the rest of the stack uses.
const LAYOUT_MODEL = process.env.LAYOUT_MODEL || 'claude-sonnet-4-6';
// Retouch prompt rewriting: turns what the reader typed into an instruction the
// image model can follow. Short, structured, high volume -- Haiku by default.
// Raise it to Sonnet via RETOUCH_MODEL in Railway if the wording disappoints.
const RETOUCH_MODEL = process.env.RETOUCH_MODEL || HELP_MODEL;
// v3.2.27 -- TD-999 writing tools. WRITING_MODEL runs Feedback, Show me and one-box Regen; WRITING_FAST_MODEL is for
// the lighter tools of stage 2 (Rewrite, Describe, Expand, Tighten, Word) if Haiku holds up in the side-by-side test.
const WRITING_MODEL = process.env.WRITING_MODEL || TEXT_MODEL;
const WRITING_FAST_MODEL = process.env.WRITING_FAST_MODEL || HELP_MODEL;

// fal.ai image models. IMAGE_MODELS = base (text-to-image) endpoint per key;
// IMAGE_EDIT_MODELS = the /edit (reference-image) endpoint for keys that have one.
// v3.2.29 -- THE NANO MODEL IS A RAILWAY VARIABLE. Ian, 2026-10-21: switch staging to Nano Banana 2.1
// (same look in an 11-style side-by-side test, same speed, about half the price) without a code change.
//   FAL_IMAGE_MODEL      the plain picture endpoint      (unset = fal-ai/nano-banana-2)
//   FAL_IMAGE_EDIT_MODEL the reference / retouch / edit endpoint (unset = fal-ai/nano-banana-2/edit)
// Set both together (e.g. google/nano-banana-2.1 and google/nano-banana-2.1/edit). Unset, blank or not
// shaped like a fal endpoint path falls back to today's model, so production is unchanged until its own
// variables are set. The key stays 'nano2' everywhere else in the code; only the endpoint string moves.
function falEndpoint(envName, fallback) {
  var v = String(process.env[envName] || '').trim();
  if (!v) return fallback;
  if (!/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)+$/i.test(v)) {
    console.warn('[models] ' + envName + ' is not a fal endpoint path; using ' + fallback);
    return fallback;
  }
  return v;
}
const IMAGE_MODELS = {
  schnell: 'fal-ai/flux/schnell',
  nano2: falEndpoint('FAL_IMAGE_MODEL', 'fal-ai/nano-banana-2')
};
const IMAGE_EDIT_MODELS = {
  nano2: falEndpoint('FAL_IMAGE_EDIT_MODEL', 'fal-ai/nano-banana-2/edit')
};

module.exports = { TEXT_MODEL, HELP_MODEL, LAYOUT_MODEL, RETOUCH_MODEL, WRITING_MODEL, WRITING_FAST_MODEL, IMAGE_MODELS, IMAGE_EDIT_MODELS };
