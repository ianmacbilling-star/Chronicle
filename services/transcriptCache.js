// v3.2.56 -- TD-1010 PROMPT CACHING FOR THE TRANSCRIPT (Ian, 2026-10-24).
// Generate Story, the character-change check that runs seconds after it, and Generate Narrative all send the whole
// session transcript, the longest thing any of them sends. Each now puts it FIRST, at the very front of its system
// instructions, as this one block, word for word the same in all three, marked for Anthropic to keep five minutes.
// Each call's own instructions follow it unchanged. So the change check always reads the transcript at a tenth of the
// price, and so does Generate Narrative when it runs within five minutes of Generate Story (later, it pays the write
// price, 1.25x). Anthropic matches from the very start of a request, which is why the block goes before the system
// instructions and not in the message: the three calls' instructions differ. Change this text and all three change.
// Already Written does not use it (it sends the text as numbered sentences instead).
'use strict';
function transcriptBlock(transcript) {
  return { type: 'text', text: '## SESSION TRANSCRIPT (what actually happened in this session)\n' + String(transcript == null ? '' : transcript) + '\n', cache_control: { type: 'ephemeral' } };
}
// One Railway line per call, because a cache that stops matching fails silently (the same instrument as Help's).
function logCache(label, data) {
  try {
    const u = data && data.usage;
    if (u) console.log('[story cache] ' + label + ' write=' + (u.cache_creation_input_tokens || 0) + ' read=' + (u.cache_read_input_tokens || 0) +
      ' uncached_in=' + (u.input_tokens || 0) + ' out=' + (u.output_tokens || 0));
  } catch (e) {}
}
module.exports = { transcriptBlock, logCache };
