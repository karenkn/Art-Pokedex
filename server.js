const express   = require('express');
const cors      = require('cors');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { Pool }  = require('pg');

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
}).then(() => {
  // Add pinned column if it doesn't exist yet (for existing databases)
  return pool.query(`ALTER TABLE photos ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT FALSE`);
}).catch(err => console.error('Database init error:', err.message));

pool.query(`
  CREATE TABLE IF NOT EXISTS submissions (
    id              TEXT PRIMARY KEY,
    name            TEXT,
    thumbnail       TEXT,
    painting_name   TEXT DEFAULT '',
    artist          TEXT DEFAULT '',
    location        TEXT DEFAULT '',
    country         TEXT DEFAULT '',
    style           TEXT DEFAULT '',
    medium          TEXT DEFAULT '',
    period          TEXT DEFAULT '',
    confidence      INTEGER,
    description     TEXT DEFAULT '',
    artist_hint     TEXT DEFAULT '',
    submitter_name  TEXT NOT NULL,
    submitter_email TEXT NOT NULL,
    note            TEXT DEFAULT '',
    status          TEXT DEFAULT 'pending',
    created_at      TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(err => console.error('Submissions table init error:', err.message));

pool.query(`
  CREATE TABLE IF NOT EXISTS posts (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL DEFAULT '',
    slug         TEXT NOT NULL DEFAULT '',
    content      TEXT NOT NULL DEFAULT '',
    excerpt      TEXT NOT NULL DEFAULT '',
    published    BOOLEAN DEFAULT TRUE,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(err => console.error('Posts table init error:', err.message));

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

// ── Rate limiting (public endpoints) ─────────────────────────────────────────
// Admins with a valid JWT bypass rate limits.
const analyzeLimit = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many analysis requests. Please try again in 15 minutes.' } }
});
const submitLimit = rateLimit({
  windowMs: 60 * 60 * 1000,   // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions. Please try again later.' }
});

// Middleware factory: apply the given limiter only if the request is NOT from
// a verified admin (i.e. no valid Bearer JWT).  Admins bypass entirely.
function publicRateLimit(limiter) {
  return (req, res, next) => {
    if (JWT_SECRET) {
      const header = req.headers['authorization'] || '';
      const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (token) {
        try { jwt.verify(token, JWT_SECRET); return next(); } catch {}
      }
    }
    return limiter(req, res, next);
  };
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'Art Photo Organizer Proxy' });
});

// ── GET /api/config — returns public client config (Maps key is domain-restricted) ──
app.get('/api/config', (_req, res) => {
  res.json({ mapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '' });
});

// ── GET /api/places?input=<query>&sessiontoken=<token> — Places Autocomplete ──
app.get('/api/places', async (req, res) => {
  const { input, sessiontoken } = req.query;
  if (!input || input.length < 2) return res.json({ suggestions: [] });
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return res.status(500).json({ error: 'GOOGLE_MAPS_API_KEY not set on server.' });
  try {
    const response = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key },
      body: JSON.stringify({ input, sessionToken: sessiontoken || undefined })
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Places autocomplete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/place-details?place_id=<id>&sessiontoken=<token> — Place Details ──
app.get('/api/place-details', async (req, res) => {
  const { place_id, sessiontoken } = req.query;
  if (!place_id) return res.status(400).json({ error: 'place_id required' });
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return res.status(500).json({ error: 'GOOGLE_MAPS_API_KEY not set on server.' });
  try {
    const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(place_id)}` +
                `?fields=location,addressComponents,displayName` +
                (sessiontoken ? `&sessionToken=${encodeURIComponent(sessiontoken)}` : '');
    const response = await fetch(url, {
      headers: { 'X-Goog-Api-Key': key, 'Content-Type': 'application/json' }
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Place details error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/reverse-geocode?lat=<lat>&lng=<lng> — Nominatim proxy ───────────
app.get('/api/reverse-geocode', async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&format=json&accept-language=en`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'ArtPhotoOrganizer/1.0' }
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Reverse geocode error:', err.message);
    res.status(500).json({ error: err.message });
  }
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

// ── PATCH /api/photos/:id/pin — admin: pin/unpin a photo ─────────────────────
// Body: { pinned: true | false }
// Pinning a photo marks it as the featured card in its group.
// When pinning, any other photo in the same group (same location+style+artist)
// is automatically unpinned so only one pin exists per group.
app.patch('/api/photos/:id/pin', authenticate, async (req, res) => {
  try {
    const { pinned } = req.body;
    const isPinning = !!pinned;

    if (isPinning) {
      // Find the group key (location + style + artist) of the target photo
      const photoRes = await pool.query(
        'SELECT location, style, artist FROM photos WHERE id = $1',
        [req.params.id]
      );
      if (photoRes.rowCount === 0) return res.status(404).json({ error: 'Photo not found.' });
      const { location, style, artist } = photoRes.rows[0];

      // Unpin any existing pin in the same group, then pin this photo
      await pool.query(
        `UPDATE photos SET pinned = FALSE
         WHERE id != $1
           AND COALESCE(location, '') = COALESCE($2, '')
           AND COALESCE(style,    '') = COALESCE($3, '')
           AND COALESCE(artist,   '') = COALESCE($4, '')`,
        [req.params.id, location, style, artist]
      );
    }

    const result = await pool.query(
      'UPDATE photos SET pinned = $1 WHERE id = $2 RETURNING pinned',
      [isPinning, req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Photo not found.' });
    res.json({ ok: true, pinned: result.rows[0].pinned });
  } catch (err) {
    console.error('Pin error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Claude proxy — public (rate-limited) / admin (unlimited) ─────────────────
app.post('/api/analyze', publicRateLimit(analyzeLimit), async (req, res) => {
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

// ── POST /api/submit — public (rate-limited): submit a photo for review ───────
app.post('/api/submit', publicRateLimit(submitLimit), async (req, res) => {
  const {
    id, name, thumbnail,
    paintingName, artist, location, country, style, medium, period,
    confidence, description, artistHint,
    submitterName, submitterEmail, note,
    _hp, _t   // spam-protection fields
  } = req.body;

  // ── Spam protection ────────────────────────────────────────────────────────
  // Honeypot: a hidden field that only bots fill in.
  // Respond with 200 (fake success) so the bot doesn't know it was rejected.
  if (_hp) {
    console.warn('Spam blocked (honeypot):', submitterEmail || '(no email)');
    return res.json({ ok: true });
  }
  // Timing gate: real users take at least 4 seconds to read the form.
  // Allow a generous margin (3 s) in case of slow connections / fast readers.
  const MIN_MS = 3000;
  if (typeof _t === 'number' && _t < MIN_MS) {
    console.warn('Spam blocked (too fast):', _t + 'ms', submitterEmail || '(no email)');
    return res.json({ ok: true });
  }
  // ──────────────────────────────────────────────────────────────────────────

  if (!submitterName || !submitterEmail) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }
  if (!id || !thumbnail) {
    return res.status(400).json({ error: 'Photo data is required.' });
  }

  try {
    await pool.query(
      `INSERT INTO submissions
         (id, name, thumbnail, painting_name, artist, location, country,
          style, medium, period, confidence, description, artist_hint,
          submitter_name, submitter_email, note, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pending')
       ON CONFLICT (id) DO NOTHING`,
      [
        id, name || '', thumbnail,
        paintingName || '', artist    || '',
        location     || '', country   || '',
        style        || '', medium    || '',
        period       || '', confidence ?? null,
        description  || '', artistHint || '',
        submitterName, submitterEmail, note || ''
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Submit error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/submissions — admin only: list pending submissions ───────────────
app.get('/api/submissions', authenticate, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM submissions WHERE status = 'pending' ORDER BY created_at ASC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Load submissions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/submissions/:id — admin only: approve or reject ────────────────
// Body: { action: 'approve' | 'reject' }
app.patch('/api/submissions/:id', authenticate, async (req, res) => {
  const { action } = req.body;
  if (action !== 'approve' && action !== 'reject') {
    return res.status(400).json({ error: "action must be 'approve' or 'reject'." });
  }
  try {
    if (action === 'approve') {
      // Copy submission into photos table, then mark approved
      const sel = await pool.query('SELECT * FROM submissions WHERE id = $1', [req.params.id]);
      if (sel.rowCount === 0) return res.status(404).json({ error: 'Submission not found.' });
      const s = sel.rows[0];
      await pool.query(
        `INSERT INTO photos
           (id, name, thumbnail, painting_name, artist, location, country,
            style, medium, period, confidence, description, artist_hint,
            manually_edited, location_source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,FALSE,'ai')
         ON CONFLICT (id) DO NOTHING`,
        [
          s.id, s.name, s.thumbnail,
          s.painting_name, s.artist,   s.location, s.country,
          s.style,         s.medium,   s.period,   s.confidence,
          s.description,   s.artist_hint
        ]
      );
    }
    await pool.query(
      `UPDATE submissions SET status = $1 WHERE id = $2`,
      [action === 'approve' ? 'approved' : 'rejected', req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Review submission error:', err.message);
    res.status(500).json({ error: err.message });
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

// ── GET /api/posts — public: list all published posts ────────────────────────
app.get('/api/posts', async (_req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, title, slug, excerpt, published, created_at, updated_at FROM posts WHERE published = TRUE ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Load posts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/posts/all — admin only: list all posts including drafts ──────────
app.get('/api/posts/all', authenticate, async (_req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, title, slug, excerpt, published, created_at, updated_at FROM posts ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Load all posts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/posts/:id — public: single post with full content ────────────────
app.get('/api/posts/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM posts WHERE id = $1',
      [req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Post not found.' });
    const post = result.rows[0];
    // Only return unpublished posts to admins
    if (!post.published) {
      const header = req.headers['authorization'] || '';
      const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (!token) return res.status(404).json({ error: 'Post not found.' });
      try { jwt.verify(token, JWT_SECRET); } catch { return res.status(404).json({ error: 'Post not found.' }); }
    }
    res.json(post);
  } catch (err) {
    console.error('Get post error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/posts — admin only: create post ────────────────────────────────
app.post('/api/posts', authenticate, async (req, res) => {
  const { id, title, slug, content, excerpt, published } = req.body;
  try {
    await pool.query(
      `INSERT INTO posts (id, title, slug, content, excerpt, published)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title, slug = EXCLUDED.slug,
         content = EXCLUDED.content, excerpt = EXCLUDED.excerpt,
         published = EXCLUDED.published, updated_at = NOW()`,
      [id, title || '', slug || '', content || '', excerpt || '', published !== false]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Create post error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/posts/:id — admin only: update post ─────────────────────────────
app.put('/api/posts/:id', authenticate, async (req, res) => {
  const { title, slug, content, excerpt, published } = req.body;
  try {
    const result = await pool.query(
      `UPDATE posts SET
         title = $1, slug = $2, content = $3, excerpt = $4,
         published = $5, updated_at = NOW()
       WHERE id = $6`,
      [title || '', slug || '', content || '', excerpt || '', published !== false, req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Post not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Update post error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/posts/:id — admin only ───────────────────────────────────────
app.delete('/api/posts/:id', authenticate, async (req, res) => {
  try {
    await pool.query('DELETE FROM posts WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete post error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Art Photo Organizer proxy running on port ${PORT}`);
});
