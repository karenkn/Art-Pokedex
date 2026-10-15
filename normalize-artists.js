// Normalize Artists — shared by index.html and top-works.html.
// Consolidates artist-name variants ("Van Gogh", "Vincent van Gogh", "van gogh, vincent")
// into one standard name across every artwork, then saves the changes.
// Relies on page globals: photos, adminToken, serverUrl (index) or SERVER_URL (top-works).
(function () {
  const BATCH = 30;
  const SKIP = /^(unknown|unknown artist|anonymous|unattributed|n\/a|—|-)$/i;

  const base = () => (typeof serverUrl !== 'undefined' && serverUrl) ? serverUrl
    : (typeof SERVER_URL !== 'undefined' ? SERVER_URL : '');
  const headers = () => ({ 'content-type': 'application/json', Authorization: `Bearer ${adminToken}` });
  const setLabel = (t, disabled) => document.querySelectorAll('.normalize-artists-btn').forEach(b => {
    b.textContent = t; b.disabled = !!disabled;
  });
  const DEFAULT = '👤 Normalize Artists';

  function extractJson(text) {
    const s = text.indexOf('{');
    if (s < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = s; i < text.length; i++) {
      const c = text[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return text.slice(s, i + 1);
    }
    return null;
  }

  async function post(body, tries = 3) {
    let last;
    for (let i = 0; i < tries; i++) {
      try {
        const res = await fetch(`${base()}/api/analyze`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
        if (res.status === 401) throw Object.assign(new Error('Session expired — log in again'), { fatal: true });
        const data = await res.json();
        if (!res.ok) {
          const e = new Error(data?.error?.message || `HTTP ${res.status}`);
          e.fatal = res.status >= 400 && res.status < 500 && res.status !== 429;
          throw e;
        }
        return data;
      } catch (err) {
        if (err.fatal) throw err;
        last = err;
        await new Promise(r => setTimeout(r, 1500 * (i + 1)));
      }
    }
    throw last;
  }

  async function mapBatch(names, canonical, mapping, stats) {
    const known = [...canonical].slice(0, 80);
    const prompt = `You are an art historian cataloguing a collection. Below are artist names as auto-generated from photos; the same person often appears under several spellings or formats.

Map EVERY input name to one standard canonical name.

Rules:
1. Standard format: the artist's most commonly used full name in natural order, with proper diacritics and capitalization (e.g. "Vincent van Gogh", "Claude Monet", "Pablo Picasso", "Yayoi Kusama", "Jean-Michel Basquiat").
2. Merge variants of the SAME person: surname only, "Last, First", abbreviations, alternate transliterations, misspellings, "(attributed)" noise.
3. NEVER merge two different people (e.g. Pieter Bruegel the Elder vs the Younger; father/son with the same surname). Keep suffixes like "the Elder" when needed to distinguish.
4. Keep attribution qualifiers as distinct values: "School of X", "Workshop of X", "After X", "Follower of X" stay as written (only tidy the capitalization/name inside).
5. For collectives or unknown authorship ("Unknown", "Anonymous", "Unknown Artist"), return the input unchanged.
6. If a name is already clean, return it unchanged. Prefer reusing a name from this already-chosen list when it is the same person: ${JSON.stringify(known)}

Return ONLY a valid JSON object mapping every input name (exact string) to its canonical name. Raw JSON only — no markdown, no explanation.

Names: ${JSON.stringify(names)}`;

    try {
      const data = await post({
        model: 'claude-opus-5',
        max_tokens: 4096,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
      });
      const text = data.content?.find(b => b.type === 'text')?.text || '';
      const obj = extractJson(text);
      if (!obj) throw new Error(data.stop_reason === 'max_tokens' ? 'truncated' : 'no JSON');
      const part = JSON.parse(obj);
      for (const n of names) {
        const c = typeof part[n] === 'string' ? part[n].trim() : '';
        if (c) { mapping[n] = c; canonical.add(c); } else stats.skipped++;
      }
    } catch (err) {
      if (err.fatal) throw err;
      if (names.length > 1) {
        const mid = Math.ceil(names.length / 2);
        await mapBatch(names.slice(0, mid), canonical, mapping, stats);
        await mapBatch(names.slice(mid), canonical, mapping, stats);
      } else {
        stats.skipped++;
        console.warn('Normalize artists: could not map', names[0], err.message);
      }
    }
  }

  async function normalizeArtists() {
    if (typeof adminToken === 'undefined' || !adminToken) return;
    const done = photos.filter(p => p.aiData?.artist && !SKIP.test(p.aiData.artist.trim()));
    const names = [...new Set(done.map(p => p.aiData.artist.trim()))];
    if (names.length < 2) { setLabel('✓ Already normalized'); setTimeout(() => setLabel(DEFAULT), 3000); return; }

    setLabel('⏳ Normalizing…', true);
    try {
      // Most-used spellings go first so they seed the canonical list.
      const freq = {};
      done.forEach(p => { const a = p.aiData.artist.trim(); freq[a] = (freq[a] || 0) + 1; });
      names.sort((a, b) => freq[b] - freq[a]);

      const canonical = new Set();
      const mapping = {};
      const stats = { skipped: 0 };
      const total = Math.ceil(names.length / BATCH);
      for (let i = 0; i < total; i++) {
        setLabel(`⏳ Normalizing ${i + 1}/${total}…`, true);
        await mapBatch(names.slice(i * BATCH, (i + 1) * BATCH), canonical, mapping, stats);
      }

      const changes = Object.entries(mapping).filter(([from, to]) => from !== to);
      const changed = done.filter(p => { const to = mapping[p.aiData.artist.trim()]; return to && to !== p.aiData.artist; });
      if (!changed.length) { setLabel('✓ Already normalized'); setTimeout(() => setLabel(DEFAULT), 3000); return; }

      const preview = changes.slice(0, 25).map(([f, t]) => `• ${f}  →  ${t}`).join('\n');
      const more = changes.length > 25 ? `\n…and ${changes.length - 25} more` : '';
      if (!confirm(`Rename ${changes.length} artist name${changes.length === 1 ? '' : 's'} across ${changed.length} artwork${changed.length === 1 ? '' : 's'}?\n\n${preview}${more}`)) {
        setLabel(DEFAULT); return;
      }

      // Save first; only update what the server accepted.
      let failed = 0, applied = 0;
      for (let i = 0; i < changed.length; i += 5) {
        await Promise.all(changed.slice(i, i + 5).map(async p => {
          const to = mapping[p.aiData.artist.trim()];
          try {
            const res = await fetch(`${base()}/api/photos/${p.id}`, {
              method: 'PUT', headers: headers(), body: JSON.stringify({ aiData: { ...p.aiData, artist: to } })
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            p.aiData.artist = to; applied++;
          } catch (e) { failed++; console.warn('Normalize artists: save failed for', p.id, e.message); }
        }));
      }
      if (typeof renderList === 'function') renderList();
      if (typeof render === 'function') render();
      setLabel(`✓ ${applied} updated${failed ? ` · ${failed} failed` : ''}`);
      setTimeout(() => setLabel(DEFAULT), 5000);
    } catch (err) {
      console.error('Normalize artists error:', err);
      setLabel(`⚠ ${String(err.message).slice(0, 40)}`);
      setTimeout(() => setLabel(DEFAULT), 5000);
    }
  }

  window.normalizeArtists = normalizeArtists;
})();
