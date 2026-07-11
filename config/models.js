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

// fal.ai image models. IMAGE_MODELS = base (text-to-image) endpoint per key;
// IMAGE_EDIT_MODELS = the /edit (reference-image) endpoint for keys that have one.
const IMAGE_MODELS = {
  schnell: 'fal-ai/flux/schnell',
  nano2: 'fal-ai/nano-banana-2'
};
const IMAGE_EDIT_MODELS = {
  nano2: 'fal-ai/nano-banana-2/edit'
};

module.exports = { TEXT_MODEL, HELP_MODEL, LAYOUT_MODEL, IMAGE_MODELS, IMAGE_EDIT_MODELS };
