const express = require('express');
const path = require('path');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/extract', async (req, res) => {
  const { key, transcript, artStyle, charList } = req.body;
  if (!key || !transcript) return res.json({ error: 'Missing key or transcript' });
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: 'You are a graphic novel director analyzing a TTRPG session transcript. Extract 4-6 key cinematic moments that would make the best graphic novel panels. Focus on dramatic combat, emotional revelations, tense standoffs, and memorable character moments.\n\nArt style: ' + artStyle + '\n\nKnown characters:\n' + charList + '\n\nTranscript:\n' + transcript + '\n\nReturn ONLY valid JSON with no markdown fences or explanation:\n{\n  "title": "Session title (4-6 dramatic words)",\n  "subtitle": "The party of [names]",\n  "moments": [\n    {\n      "title": "Short evocative panel title",\n      "description": "One sentence visual scene description for an artist",\n      "type": "combat|drama|discovery|humor",\n      "prompt": "Detailed image generation prompt in the chosen art style. Describe composition, lighting, character positions, mood. 2-3 sentences."\n    }\n  ]\n}'
        }]
      })
    });
    const data = await response.json();
    if (data.error) return res.json({ error: data.error.message });
    const raw = data.content.map(b => b.text || '').join('');
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    res.json(parsed);
  } catch(e) {
    res.json({ error: e.message });
  }
});

app.listen(3000, () => {
  console.log('');
  console.log('  Chronicle is running!');
  console.log('  Open: http://localhost:3000');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});
