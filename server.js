const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '25mb' }));

// ── Database ──────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Create the photos table if it doesn't exist yet
pool.query(`
  CREATE TABLE IF NOT EXISTS photos (
    id             TEXT PRIMARY KEY,
    name           TEXT,
    thumbnail      TEXT,
    painting_name  TEXT,
    artist         TEXT,
    location       TEXT,
    country        TEXT,
    style          TEXT,
    medium         TEXT,
    period         TEXT,
    confidence     INTEGER,
    description    TEXT,
    artist_hint    TEXT,
    manually_edited BOOLEAN DEFAULT FALSE,
    location_source TEXT DEFAULT 'ai',
    gps_lat        FLOAT,
    gps_lng        FLOAT,
    ai_model       TEXT,
    created_at     TIMESTAMPTZ DEFAULT NOW()
  )
`).then(() => console.log('Database ready'))
  .catch(err => console.error('Database init error:', err.message));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'Art Photo Organizer Proxy' });
});

// ── Claude proxy ──────────────────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: { message: 'ANTHROPIC_API_KEY is not set on the server.' }
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

// ── GET /api/photos — load all saved photos ───────────────────────────────────
app.get('/api/photos', async (_req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM photos ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Load photos error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/photos — save a photo after analysis ───────────────────────────
app.post('/api/photos', async (req, res) => {
  const { id, name, thumbnail, aiData, locationSource, gpsCoords } = req.body;
  const d = aiData || {};
  try {
    await pool.query(
      `INSERT INTO photos
         (id, name, thumbnail, painting_name, artist, location, country,
          style, medium, period, confidence, description, artist_hint,
          manually_edited, location_source, gps_lat, gps_lng, ai_model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (id) DO UPDATE SET
         painting_name   = EXCLUDED.painting_name,
         artist          = EXCLUDED.artist,
         location        = EXCLUDED.location,
         country         = EXCLUDED.country,
         style           = EXCLUDED.style,
         medium          = EXCLUDED.medium,
         period          = EXCLUDED.period,
         confidence      = EXCLUDED.confidence,
         description     = EXCLUDED.description,
         artist_hint     = EXCLUDED.artist_hint,
         manually_edited = EXCLUDED.manually_edited,
         location_source = EXCLUDED.location_source,
         gps_lat         = EXCLUDED.gps_lat,
         gps_lng         = EXCLUDED.gps_lng`,
      [
        id, name, thumbnail,
        d.paintingName || '', d.artist    || '',
        d.location     || '', d.country   || '',
        d.style        || '', d.medium    || '',
        d.period       || '', d.confidence ?? null,
        d.description  || '', d.artistHint || '',
        d.manuallyEdited || false,
        locationSource || 'ai',
        gpsCoords ? gpsCoords[0] : null,
        gpsCoords ? gpsCoords[1] : null,
        d.model || null
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Save photo error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/photos/:id — update metadata after manual edit ──────────────────
app.put('/api/photos/:id', async (req, res) => {
  const { aiData } = req.body;
  const d = aiData || {};
  try {
    await pool.query(
      `UPDATE photos SET
         painting_name   = $1, artist     = $2, location  = $3,
         country         = $4, style      = $5, medium    = $6,
         period          = $7, confidence = $8, description = $9,
         artist_hint     = $10, manually_edited = $11
       WHERE id = $12`,
      [
        d.paintingName || '', d.artist   || '', d.location  || '',
        d.country      || '', d.style    || '', d.medium    || '',
        d.period       || '', d.confidence ?? null, d.description || '',
        d.artistHint   || '', d.manuallyEdited || false,
        req.params.id
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Update photo error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/photos/:id — remove a single photo ───────────────────────────
app.delete('/api/photos/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM photos WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete photo error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/photos — clear all photos ────────────────────────────────────
app.delete('/api/photos', async (_req, res) => {
  try {
    await pool.query('DELETE FROM photos');
    res.json({ ok: true });
  } catch (err) {
    console.error('Clear photos error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Art Photo Organizer proxy running on port ${PORT}`);
});
