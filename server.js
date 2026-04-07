const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
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
    likes          INTEGER DEFAULT 0,
    created_at     TIMESTAMPTZ DEFAULT NOW()
  )
`).then(() => {
  console.log('Database ready');
  // Add likes column if it doesn't exist yet (for existing databases)
  return pool.query(`ALTER TABLE photos ADD COLUMN IF NOT EXISTS likes INTEGER DEFAULT 0`);
}).catch(err => console.error('Database init error:', err.message));

// ── Auth helpers ──────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET;

// Middleware: verify JWT on write requests
function authenticate(req, res, next) {
  if (!JWT_SECRET) {
    return res.status(500).json({ error: 'JWT_SECRET is not configured on the server.' });
  }
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated. Please log in as admin.' });
  }
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
  }
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'Art Photo Organizer Proxy' });
});

// ── POST /api/login ───────────────────────────────────────────────────────────
// Body: { password: "..." }
// Returns: { token: "<jwt>" }  (valid 12 hours)
app.post('/api/login', async (req, res) => {
  if (!JWT_SECRET) {
    return res.status(500).json({ error: 'JWT_SECRET is not configured on the server.' });
  }
  const { password } = req.body;
  const hash = process.env.ADMIN_PASSWORD_HASH;
  if (!hash) {
    return res.status(500).json({ error: 'ADMIN_PASSWORD_HASH is not configured on the server.' });
  }
  const valid = await bcrypt.compare(password || '', hash);
  if (!valid) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
});

// ── POST /api/photos/:id/like — public: add a like ───────────────────────────
app.post('/api/photos/:id/like', async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE photos SET likes = likes + 1 WHERE id = $1 RETURNING likes',
      [req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Photo not found.' });
    res.json({ likes: result.rows[0].likes });
  } catch (err) {
    console.error('Like error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/photos/:id/like — public: remove a like ──────────────────────
app.delete('/api/photos/:id/like', async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE photos SET likes = GREATEST(likes - 1, 0) WHERE id = $1 RETURNING likes',
      [req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Photo not found.' });
    res.json({ likes: result.rows[0].likes });
  } catch (err) {
    console.error('Unlike error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Claude proxy (admin only) ─────────────────────────────────────────────────
app.post('/api/analyze', authenticate, async (req, res) => {
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

// ── GET /api/photos — public: anyone can view ─────────────────────────────────
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

// ── POST /api/photos — admin only ────────────────────────────────────────────
app.post('/api/photos', authenticate, async (req, res) => {
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

// ── PUT /api/photos/:id — admin only ─────────────────────────────────────────
app.put('/api/photos/:id', authenticate, async (req, res) => {
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

// ── DELETE /api/photos/:id — admin only ──────────────────────────────────────
app.delete('/api/photos/:id', authenticate, async (req, res) => {
  try {
    await pool.query('DELETE FROM photos WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete photo error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/photos — admin only ──────────────────────────────────────────
app.delete('/api/photos', authenticate, async (_req, res) => {
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
