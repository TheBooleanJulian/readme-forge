const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

app.post('/api/generate', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY.' });
  }

  const prompt = req.body && req.body.prompt;
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Missing "prompt" in request body.' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      const message = (data && data.error && data.error.message) || ('Claude API error: ' + response.status);
      return res.status(response.status).json({ error: message });
    }

    const textBlocks = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text);
    res.json({ text: textBlocks.join('\n').trim() });
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach Claude API: ' + err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log('readme-forge listening on port ' + PORT);
});
