const express = require('express');
const cors    = require('cors');

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());                          // allow requests from any origin
app.use(express.json({ limit: '25mb' })); // photos arrive as base64 strings

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'Art Photo Organizer Proxy' });
});

// ── Main proxy endpoint ───────────────────────────────────────────────────────
// The HTML app sends the full Anthropic request body here.
// We add the API key (from the environment) and forward it to Anthropic.
app.post('/api/analyze', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: { message: 'ANTHROPIC_API_KEY is not set on the server. Add it in your Railway environment variables.' }
    });
  }

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json'
      },
      body: JSON.stringify(req.body)
    });

    const data = await anthropicRes.json();
    res.status(anthropicRes.status).json(data);

  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
// Railway injects PORT automatically; fall back to 3000 for local dev.
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Art Photo Organizer proxy running on port ${PORT}`);
});
