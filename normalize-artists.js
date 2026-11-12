// Normalize Artists — shared by index.html and top-works.html.
// Consolidates artist-name variants ("Van Gogh", "Vincent van Gogh", "van gogh, vincent")
// into one standard name across every artwork, then saves the changes.
// Relies on page globals: photos, adminToken, serverUrl (index) or SERVER_URL (top-works).
(function () {
  const BATCH = 30;

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
1. Standard format: the artist's name as "First Last", the way it is most commonly cataloged, with proper diacritics and capitalization (e.g. "Vincent van Gogh", "Claude Monet", "Pablo Picasso", "Yayoi Kusama", "Jean-Michel Basquiat"). Use a single name for artists known by one (e.g. "Banksy", "Rembrandt"). No middle names, initials, titles, dates or nationality.
2. Merge variants of the SAME person: surname only, "Last, First", abbreviations, alternate transliterations, misspellings.
3. NEVER merge two different people. Keep catalog suffixes where they apply: "the Elder", "the Younger", "Jr.", "Sr." (e.g. "Pieter Bruegel the Elder", "Pieter Bruegel the Younger").
4. KEEP attribution qualifiers, in this standard form in front of the name: "School of", "Workshop of", "Studio of", "Circle of", "Follower of", "After" (e.g. "School of Caravaggio"). Tidy the name inside to "First Last". Never merge a qualified name with the master's own name — they are different values.
5. REMOVE every expression of uncertainty, confidence or commentary: "Attributed to", "Possibly", "Probably", "Likely", "Perhaps", question marks, "(attributed)", "(85% confident)", dates, notes, and any trailing description after a dash or slash. Return only the clean name. Example: "Pablo Picasso (attributed on stylistic grounds) — otherwise Parisian Synthetic Cubist circle" → "Pablo Picasso". If the text names no specific artist (only a school, city or movement), return "Unknown Artist".
6. For collectives or unknown authorship ("Unknown", "Anonymous", "Unidentified"), return exactly "Unknown Artist".
7. If a name is already clean, return it unchanged. Prefer reusing a name from this already-chosen list when it is the same person: ${JSON.stringify(known)}

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
        let c = typeof part[n] === 'string' ? part[n].trim() : '';
        if (c && typeof cleanArtistName === 'function') c = cleanArtistName(c) || c; // safety net: drop any commentary the model slipped in
        if (c) { mapping[n] = c; canonical.add(c); } else stats.skipped++;
      }
    } catch (err) {
      if (err.fatal) throw err;
      // Only an unreadable/truncated reply is worth retrying in smaller halves. Network or
      // server errors already got several retries; give up on this batch so we don't stall —
      // its names still receive the deterministic local cleanup.
      const unreadable = err instanceof SyntaxError || /^(truncated|no JSON)$/.test(err.message);
      if (!unreadable) {
        stats.skipped += names.length;
        console.warn('Normalize artists: AI step failed for a batch —', err.message);
        return;
      }
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
    const clean = typeof cleanArtistName === 'function' ? cleanArtistName : (s => s.trim());
    const withArtist = photos.filter(p => p.aiData?.artist && p.aiData.artist.trim());

    // Step 1 — deterministic cleanup, no AI: strips parentheses, "— commentary", uncertainty
    // words, "Last, First" ordering, unknown variants. This always applies, even if the AI step fails.
    const pre = {};                       // raw artist string → locally cleaned name
    withArtist.forEach(p => { const raw = p.aiData.artist.trim(); if (!(raw in pre)) pre[raw] = clean(raw) || raw; });
    const freq = {};
    withArtist.forEach(p => { const k = pre[p.aiData.artist.trim()]; freq[k] = (freq[k] || 0) + 1; });
    const aiNames = Object.keys(freq).filter(n => n !== 'Unknown Artist').sort((a, b) => freq[b] - freq[a]);

    setLabel('⏳ Normalizing…', true);
    try {
      // Step 2 — AI merges variants of the same person ("Van Gogh" / "Vincent van Gogh").
      // It only sees the already-cleaned names, most-used first so they seed the canonical list.
      const canonical = new Set();
      const aiMap = {};
      const stats = { skipped: 0 };
      if (aiNames.length >= 2) {
        const total = Math.ceil(aiNames.length / BATCH);
        for (let i = 0; i < total; i++) {
          setLabel(`⏳ Normalizing ${i + 1}/${total}…`, true);
          await mapBatch(aiNames.slice(i * BATCH, (i + 1) * BATCH), canonical, aiMap, stats);
        }
      }

      // Final name = AI result (cleaned again) or, if the AI skipped it, the local cleanup.
      const finalFor = raw => { const p = pre[raw]; return clean(aiMap[p] || p) || p; };

      const changed = withArtist.filter(p => finalFor(p.aiData.artist.trim()) !== p.aiData.artist);
      if (!changed.length) {
        setLabel(stats.skipped ? `✓ Done · ${stats.skipped} left as-is` : '✓ Already normalized');
        setTimeout(() => setLabel(DEFAULT), 4000); return;
      }
      const changes = [...new Set(changed.map(p => p.aiData.artist.trim()))]
        .map(raw => [raw, finalFor(raw)])
        .filter(([from, to]) => from !== to);

      const clip = t => (t.length > 70 ? t.slice(0, 67) + '…' : t);
      const preview = changes.slice(0, 25).map(([f, t]) => `• ${clip(f)}  →  ${t}`).join('\n');
      const more = changes.length > 25 ? `\n…and ${changes.length - 25} more` : '';
      const note = stats.skipped ? `\n\n(${stats.skipped} name${stats.skipped === 1 ? '' : 's'} could not be merged by the AI and only got the local cleanup.)` : '';
      if (!confirm(`Rename ${changes.length} artist name${changes.length === 1 ? '' : 's'} across ${changed.length} artwork${changed.length === 1 ? '' : 's'}?\n\n${preview}${more}${note}`)) {
        setLabel(DEFAULT); return;
      }

      // Save first; only update what the server accepted.
      let failed = 0, applied = 0;
      for (let i = 0; i < changed.length; i += 5) {
        await Promise.all(changed.slice(i, i + 5).map(async p => {
          const to = finalFor(p.aiData.artist.trim());
          try {
            const res = await fetch(`${base()}/api/photos/${p.id}`, {
              method: 'PUT', headers: headers(), body: JSON.stringify({ aiData: { ...p.aiData, artist: to }, source: 'normalize' })
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
