// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────
let photos = [];
let submissions = [];
let currentFilter = 'artist';
let currentSort   = 'liked';
let serverUrl = '';
let analysisQueue = Promise.resolve();  // serialise API calls
let recentlyAddedIds = new Set();       // IDs of photos that finished analysis this session
let currentAllMode  = 'grouped';        // 'grouped' | 'flat' — only applies when currentFilter === 'all'
let adminToken = null;  // set on successful login; null = view-only mode
const likedIds = new Set(); // track photos liked this session to prevent duplicates
const TIER_LABELS = { like: '👍 Like', okay: '😐 Okay', dislike: '👎 Dislike' };
let isLoading = true;  // true while initial DB fetch is in flight
let selectMode = false;
const selectedPhotoIds = new Set();

function authHeaders(extra) {
  const h = Object.assign({ 'content-type': 'application/json' }, extra || {});
  if (adminToken) h['Authorization'] = `Bearer ${adminToken}`;
  return h;
}

// ── Admin login UI ────────────────────────────────────────────────────────────
function toggleAdminLogin() {
  if (adminToken) {
    // Already logged in — log out
    adminToken = null;
    updateAdminUI();
  } else {
    document.getElementById('loginModalBg').classList.add('open');
    document.getElementById('adminPasswordInput').value = '';
    document.getElementById('loginError').style.display = 'none';
    setTimeout(() => document.getElementById('adminPasswordInput').focus(), 50);
  }
}

function closeLoginModal() {
  document.getElementById('loginModalBg').classList.remove('open');
}

async function submitLogin() {
  const password = document.getElementById('adminPasswordInput').value;
  const errEl    = document.getElementById('loginError');
  errEl.style.display = 'none';
  try {
    const res  = await fetch(`${serverUrl}/api/login`, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ password })
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent    = data.error || 'Login failed.';
      errEl.style.display  = 'block';
      return;
    }
    adminToken = data.token;
    closeLoginModal();
    updateAdminUI();
  } catch (err) {
    errEl.textContent   = 'Could not reach server. Check your server URL.';
    errEl.style.display = 'block';
  }
}

function updateAdminUI() {
  const isAdmin = !!adminToken;
  const btn = document.getElementById('adminBtn');
  btn.textContent = isAdmin ? '🔓 Logged In (Logout)' : '🔒 Admin Login';
  btn.classList.toggle('logged-in', isAdmin);

  // Show / hide admin-only controls
  document.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = isAdmin ? '' : 'none';
  });
  // Show / hide delete + pin buttons on existing cards
  document.querySelectorAll('.delete-btn, .pin-btn').forEach(el => {
    el.dataset.adminVisible = isAdmin ? '1' : '0';
  });
  if (isAdmin) {
    loadSubmissions();
    updateLocationBanner();
  } else {
    submissions = [];
    updateSubmissionsBadge();
    if (currentFilter === 'submissions') { currentFilter = 'all'; document.querySelector('.filter-btn').classList.add('active'); }
    const locBanner = document.getElementById('locationBanner');
    if (locBanner) locBanner.style.display = 'none';
  }
  render();
}

// ── Location permission banner ─────────────────────────────────────────────
async function updateLocationBanner() {
  const banner = document.getElementById('locationBanner');
  if (!banner) return;
  if (!navigator.geolocation || !window.isSecureContext) {
    banner.style.display = 'none';
    return;
  }
  try {
    const perm = await navigator.permissions.query({ name: 'geolocation' });
    applyLocationBannerState(perm.state);
    perm.addEventListener('change', () => applyLocationBannerState(perm.state));
  } catch {
    banner.style.display = 'none'; // Permissions API unsupported — fail silently
  }
}

function applyLocationBannerState(state) {
  const banner = document.getElementById('locationBanner');
  if (!banner) return;
  banner.className = 'location-banner';
  if (state === 'granted') {
    banner.style.display = 'none';
    if (!_deviceLocationPromise) getDeviceLocation(); // pre-warm the cache
  } else if (state === 'denied') {
    banner.classList.add('state-denied');
    banner.innerHTML = `<span>🚫 Location access is blocked — GPS won't be used for museum detection.</span>
      <button class="location-banner-btn" onclick="showLocationHelp()">How to fix in Chrome</button>`;
    banner.style.display = '';
  } else {
    // 'prompt' state — not yet asked
    banner.classList.add('state-prompt');
    banner.innerHTML = `<span>📍 Enable location so GPS coordinates help identify the museum or gallery.</span>
      <button class="location-banner-btn" onclick="requestLocationFromBanner()">Enable Location</button>`;
    banner.style.display = '';
  }
}

function requestLocationFromBanner() {
  // Called directly from a click — Chrome treats this as a user gesture and
  // shows the full permission dialog rather than just the address-bar icon.
  _deviceLocationPromise   = null;
  _deviceLocationTimestamp = 0;
  getDeviceLocation().then(coords => {
    if (coords) {
      applyLocationBannerState('granted');
    } else {
      // Denied or dismissed — re-query actual state
      navigator.permissions.query({ name: 'geolocation' })
        .then(p => applyLocationBannerState(p.state))
        .catch(() => {});
    }
  });
}

function showLocationHelp() {
  const banner = document.getElementById('locationBanner');
  if (!banner) return;
  banner.className = 'location-banner state-denied';
  banner.innerHTML = `<span>Click the 🔒 lock icon in Chrome's address bar → <strong>Site settings</strong> → set <strong>Location</strong> to <em>Allow</em>, then refresh the page.</span>
    <button class="location-banner-btn" onclick="applyLocationBannerState('denied')">↩ Back</button>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Places autocomplete (location edit field)
// ─────────────────────────────────────────────────────────────────────────────
let placesDebounce = null;
let placesActiveIdx = -1;
let placesSuggestions = [];
let placesSessionToken = crypto.randomUUID ? crypto.randomUUID() : String(Math.random());

let bulkPlacesDebounce = null;
let bulkPlacesActiveIdx = -1;
let bulkPlacesSuggestions = [];
let bulkPlacesSessionToken = crypto.randomUUID ? crypto.randomUUID() : String(Math.random());

function onPlacesInput() {
  const val = document.getElementById('editLocation').value.trim();
  clearTimeout(placesDebounce);
  if (val.length < 2) { closePlacesDropdown(); return; }
  placesDebounce = setTimeout(() => fetchPlacesSuggestions(val), 300);
}

async function fetchPlacesSuggestions(input) {
  if (!serverUrl) return;
  try {
    const res  = await fetch(`${serverUrl}/api/places?input=${encodeURIComponent(input)}&sessiontoken=${encodeURIComponent(placesSessionToken)}`);
    const data = await res.json();
    placesSuggestions = data.suggestions || [];
    renderPlacesDropdown();
  } catch { closePlacesDropdown(); }
}

function renderPlacesDropdown() {
  const dropdown = document.getElementById('placesDropdown');
  if (!placesSuggestions.length) { closePlacesDropdown(); return; }
  dropdown.innerHTML = placesSuggestions.map((s, i) => {
    const pred  = s.placePrediction || {};
    const text  = pred.text?.text || '';
    const parts = text.split(',');
    const main  = parts[0] || text;
    const sub   = parts.slice(1).join(',').trim();
    return `<div class="places-option" data-idx="${i}" onmousedown="selectPlace(${i})">
      <div class="places-main">${escHtml(main)}</div>
      ${sub ? `<div class="places-sub">${escHtml(sub)}</div>` : ''}
    </div>`;
  }).join('');
  placesActiveIdx = -1;
  dropdown.classList.add('open');
}

async function selectPlace(idx) {
  const s    = placesSuggestions[idx];
  const pred = s?.placePrediction;
  if (!pred) return;

  const fullText = pred.text?.text || '';
  document.getElementById('editLocation').value = fullText;
  closePlacesDropdown();

  // Fetch place details to get country and store coords in geocache
  if (!pred.placeId) return;
  try {
    const res  = await fetch(`${serverUrl}/api/place-details?place_id=${encodeURIComponent(pred.placeId)}&sessiontoken=${encodeURIComponent(placesSessionToken)}`);
    const data = await res.json();

    // Auto-fill country from address components
    const countryComp = (data.addressComponents || []).find(c => c.types?.includes('country'));
    if (countryComp) document.getElementById('editCountry').value = countryComp.longText || '';

    // Cache coords so the map can use them without a second geocode call
    if (data.location) {
      geocodeCache[fullText] = [data.location.latitude, data.location.longitude];
    }
  } catch { /* non-critical */ }

  // Rotate session token after a complete autocomplete session
  placesSessionToken = crypto.randomUUID ? crypto.randomUUID() : String(Math.random());
}

function onPlacesKeydown(e) {
  const dropdown = document.getElementById('placesDropdown');
  const options  = dropdown.querySelectorAll('.places-option');
  if (!options.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    placesActiveIdx = Math.min(placesActiveIdx + 1, options.length - 1);
    options.forEach((o, i) => o.classList.toggle('active', i === placesActiveIdx));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    placesActiveIdx = Math.max(placesActiveIdx - 1, 0);
    options.forEach((o, i) => o.classList.toggle('active', i === placesActiveIdx));
  } else if (e.key === 'Enter' && placesActiveIdx >= 0) {
    e.preventDefault();
    selectPlace(placesActiveIdx);
  } else if (e.key === 'Escape') {
    closePlacesDropdown();
  }
}

function closePlacesDropdown() {
  document.getElementById('placesDropdown')?.classList.remove('open');
  placesSuggestions = [];
  placesActiveIdx   = -1;
}

// Close dropdown when clicking outside
document.addEventListener('click', e => {
  if (!e.target.closest('.places-wrap')) {
    closePlacesDropdown();
    closeBulkPlacesDropdown();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Bulk edit — Places autocomplete (mirrors the single-edit version)
// ─────────────────────────────────────────────────────────────────────────────
function onBulkPlacesInput() {
  const val = document.getElementById('bulkLocation').value.trim();
  clearTimeout(bulkPlacesDebounce);
  if (val.length < 2) { closeBulkPlacesDropdown(); return; }
  bulkPlacesDebounce = setTimeout(() => fetchBulkPlacesSuggestions(val), 300);
}

async function fetchBulkPlacesSuggestions(input) {
  if (!serverUrl) return;
  try {
    const res  = await fetch(`${serverUrl}/api/places?input=${encodeURIComponent(input)}&sessiontoken=${encodeURIComponent(bulkPlacesSessionToken)}`);
    const data = await res.json();
    bulkPlacesSuggestions = data.suggestions || [];
    renderBulkPlacesDropdown();
  } catch { closeBulkPlacesDropdown(); }
}

function renderBulkPlacesDropdown() {
  const dropdown = document.getElementById('bulkPlacesDropdown');
  if (!bulkPlacesSuggestions.length) { closeBulkPlacesDropdown(); return; }
  dropdown.innerHTML = bulkPlacesSuggestions.map((s, i) => {
    const pred  = s.placePrediction || {};
    const text  = pred.text?.text || '';
    const parts = text.split(',');
    const main  = parts[0] || text;
    const sub   = parts.slice(1).join(',').trim();
    return `<div class="places-option" data-idx="${i}" onmousedown="selectBulkPlace(${i})">
      <div class="places-main">${escHtml(main)}</div>
      ${sub ? `<div class="places-sub">${escHtml(sub)}</div>` : ''}
    </div>`;
  }).join('');
  bulkPlacesActiveIdx = -1;
  dropdown.classList.add('open');
}

async function selectBulkPlace(idx) {
  const s    = bulkPlacesSuggestions[idx];
  const pred = s?.placePrediction;
  if (!pred) return;

  const fullText = pred.text?.text || '';
  document.getElementById('bulkLocation').value = fullText;
  closeBulkPlacesDropdown();

  if (!pred.placeId) return;
  try {
    const res  = await fetch(`${serverUrl}/api/place-details?place_id=${encodeURIComponent(pred.placeId)}&sessiontoken=${encodeURIComponent(bulkPlacesSessionToken)}`);
    const data = await res.json();
    const countryComp = (data.addressComponents || []).find(c => c.types?.includes('country'));
    if (countryComp) document.getElementById('bulkCountry').value = countryComp.longText || '';
    if (data.location) geocodeCache[fullText] = [data.location.latitude, data.location.longitude];
  } catch { /* non-critical */ }

  bulkPlacesSessionToken = crypto.randomUUID ? crypto.randomUUID() : String(Math.random());
}

function onBulkPlacesKeydown(e) {
  const dropdown = document.getElementById('bulkPlacesDropdown');
  const options  = dropdown.querySelectorAll('.places-option');
  if (!options.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    bulkPlacesActiveIdx = Math.min(bulkPlacesActiveIdx + 1, options.length - 1);
    options.forEach((o, i) => o.classList.toggle('active', i === bulkPlacesActiveIdx));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    bulkPlacesActiveIdx = Math.max(bulkPlacesActiveIdx - 1, 0);
    options.forEach((o, i) => o.classList.toggle('active', i === bulkPlacesActiveIdx));
  } else if (e.key === 'Enter' && bulkPlacesActiveIdx >= 0) {
    e.preventDefault();
    selectBulkPlace(bulkPlacesActiveIdx);
  } else if (e.key === 'Escape') {
    closeBulkPlacesDropdown();
  }
}

function closeBulkPlacesDropdown() {
  document.getElementById('bulkPlacesDropdown')?.classList.remove('open');
  bulkPlacesSuggestions = [];
  bulkPlacesActiveIdx   = -1;
}

// ─────────────────────────────────────────────────────────────────────────────
// File handling
// ─────────────────────────────────────────────────────────────────────────────
function triggerUpload() {
  document.getElementById('fileInput').click();
}

function handleFiles(files) {
  // Kick off location permission request immediately — before analysis queues up.
  // The browser permission prompt fires now (while the user is still looking at
  // the UI), rather than mid-analysis. The cached promise is reused by every
  // analysePhoto() call so there is never a second permission prompt.
  // Kick off location permission request — show a brief hint so the user
  // notices the Chrome address-bar prompt before it auto-dismisses.
  if (window.isSecureContext && navigator.geolocation) {
    const qEl = document.getElementById('queueStatus');
    if (qEl && !_deviceLocationPromise) {
      qEl.textContent = '📍 Requesting location…';
      getDeviceLocation().then(coords => {
        if (qEl.textContent === '📍 Requesting location…') qEl.textContent = '';
        // Update the banner to reflect the outcome (granted → hide it, denied → show help)
        if (coords) {
          applyLocationBannerState('granted');
        } else if (navigator.permissions) {
          navigator.permissions.query({ name: 'geolocation' })
            .then(p => applyLocationBannerState(p.state)).catch(() => {});
        }
      });
    } else {
      getDeviceLocation();
    }
  }

  Array.from(files).forEach(file => {
    if (!file.type.startsWith('image/') && !/\.(heic|heif)$/i.test(file.name)) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const url = URL.createObjectURL(file);
    const photo = { id, file, url, name: file.name, status: 'queue', aiData: null, error: null };
    photos.push(photo);
    enqueueAnalysis(photo);
  });
  document.getElementById('fileInput').value = '';
  render();
}

function clearAll() {
  if (!confirm('Remove all photos? This will also delete them from the database.')) return;
  fetch(`${serverUrl}/api/photos`, { method: 'DELETE', headers: authHeaders() }).catch(() => {});
  photos = [];
  selectedLocation = null;
  Object.values(mapMarkers).forEach(({ marker, infoWindow }) => { marker.setMap(null); infoWindow?.close(); });
  mapMarkers = {};
  renderSidebarList([]);
  renderMapGallery(null, []);
  render();
}

async function normalizeAllLocations() {
  if (!adminToken) return;
  const btn = document.getElementById('normalizeBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Normalizing…';

  const done = photos.filter(p => p.status === 'done' && p.aiData?.location && p.aiData.location !== 'Unknown Location');
  const uniqueLocations = [...new Set(done.map(p => p.aiData.location))];

  // Step 1: Resolve every unique location string to a placeId.
  // Two different strings that share a placeId are the same venue and must be merged.
  const locToPlaceId = {}; // loc → placeId
  for (const loc of uniqueLocations) {
    try {
      const sessionToken = crypto.randomUUID ? crypto.randomUUID() : String(Math.random());
      const res  = await fetch(`${serverUrl}/api/places?input=${encodeURIComponent(loc)}&sessiontoken=${encodeURIComponent(sessionToken)}`);
      const data = await res.json();
      const placeId = data.suggestions?.[0]?.placePrediction?.placeId;
      if (placeId) locToPlaceId[loc] = placeId;
    } catch { /* skip unresolvable locations */ }
  }

  // Step 2: Group location strings by placeId.
  const placeGroups = {}; // placeId → [loc, ...]
  for (const [loc, placeId] of Object.entries(locToPlaceId)) {
    if (!placeGroups[placeId]) placeGroups[placeId] = [];
    placeGroups[placeId].push(loc);
  }

  // Step 3: For each placeId group, elect the most-used location string as canonical
  // and build a replacement map for all the others.
  const replacements = {}; // old loc → { location, country, coords }
  for (const [placeId, locs] of Object.entries(placeGroups)) {
    if (locs.length < 2) continue; // nothing to merge for this place

    // Pick whichever string the most photos already use; break ties by string length (shorter wins)
    const photoCount = loc => done.filter(p => p.aiData.location === loc).length;
    const canonical  = locs.reduce((a, b) => {
      const diff = photoCount(b) - photoCount(a);
      return diff !== 0 ? (diff > 0 ? b : a) : (a.length <= b.length ? a : b);
    });

    // Fetch coords and country for the canonical name if not already cached
    let coords  = geocodeCache[canonical] || null;
    let country = null;
    if (!coords) {
      try {
        const sessionToken = crypto.randomUUID ? crypto.randomUUID() : String(Math.random());
        const res = await fetch(`${serverUrl}/api/place-details?place_id=${encodeURIComponent(placeId)}&sessiontoken=${encodeURIComponent(sessionToken)}`);
        const det = await res.json();
        const countryComp = (det.addressComponents || []).find(c => c.types?.includes('country'));
        if (countryComp) country = countryComp.longText;
        if (det.location)  coords = [det.location.latitude, det.location.longitude];
      } catch { /* non-critical */ }
    }

    for (const loc of locs) {
      if (loc !== canonical) replacements[loc] = { location: canonical, country, coords };
    }
  }

  // Step 4: Apply replacements and persist to DB
  let updateCount = 0;
  for (const photo of done) {
    const norm = replacements[photo.aiData.location];
    if (norm) {
      photo.aiData.location = norm.location;
      if (norm.country) photo.aiData.country = norm.country;
      if (norm.coords)  geocodeCache[norm.location] = norm.coords;
      updatePhotoDB(photo);
      updateCount++;
    }
  }

  render();
  btn.disabled = false;
  btn.textContent = updateCount ? `✓ ${updateCount} updated` : '✓ Already normalized';
  setTimeout(() => { btn.textContent = '🔧 Normalize Locations'; }, 3000);
}

async function consolidateStyles() {
  if (!adminToken) return;
  const btn = document.getElementById('consolidateStylesBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Consolidating…';

  const done = photos.filter(p => p.status === 'done' && p.aiData?.style);
  const uniqueStyles = [...new Set(done.map(p => p.aiData.style).filter(s => s && s !== 'Unknown Style'))];

  if (uniqueStyles.length < 2) {
    btn.disabled = false;
    btn.textContent = '🎨 Consolidate Styles';
    return;
  }

  try {
    // Ask Claude to map every compound/specific style tag to a canonical art movement
    const res = await fetch(`${serverUrl}/api/analyze`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 1000,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: `You are an art historian. The following style tags were auto-generated and are far too specific — many use a compound "Primary / Secondary" format. Your job is to map every tag to one concise, well-known canonical art movement name, reducing the full list down to roughly 15–20 core movements.

Rules:
1. For compound "X / Y" tags, pick the most historically significant primary movement (e.g. "Mexican Muralism / Social Realism" → "Mexican Muralism").
2. Collapse overly specific sub-variants into their parent movement (e.g. "Abstract Expressionism / Gestural Abstraction" → "Abstract Expressionism").
3. Group regional or era qualifiers under the core movement (e.g. "Contemporary Figurative / Afrofuturism" → "Afrofuturism", "Fauvism / Post-Impressionism" → "Fauvism").
4. Keep genuinely distinct movements separate (Impressionism vs Post-Impressionism, Surrealism vs Cubism).
5. Use short, museum-standard names (e.g. "Cubism", "Surrealism", "Abstract Expressionism", "Pop Art", "Minimalism", "Contemporary Art").

Return ONLY a valid JSON object mapping every input tag to its canonical name. Raw JSON only — no markdown fences, no explanation, no extra keys.

Tags: ${JSON.stringify(uniqueStyles)}` }]
        }]
      })
    });

    const data = await res.json();
    const text = data.content?.[0]?.text || '';
    if (!text) throw new Error(JSON.stringify(data.error) || 'Empty response from API');
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in response');
    const mapping = JSON.parse(jsonMatch[0]);

    // Apply only entries where the canonical name differs from the current one
    let updateCount = 0;
    for (const photo of done) {
      const canonical = mapping[photo.aiData.style];
      if (canonical && canonical !== photo.aiData.style) {
        photo.aiData.style = canonical;
        updatePhotoDB(photo);
        updateCount++;
      }
    }

    render();
    btn.disabled = false;
    btn.textContent = updateCount ? `✓ ${updateCount} updated` : '✓ Already consolidated';
    setTimeout(() => { btn.textContent = '🎨 Consolidate Styles'; }, 3000);
  } catch (err) {
    console.error('Style consolidation error:', err);
    btn.disabled = false;
    btn.textContent = `⚠ Error: ${err.message.slice(0, 40)}`;
    setTimeout(() => { btn.textContent = '🎨 Consolidate Styles'; }, 4000);
  }
}

function deletePhoto(id) {
  const idx = photos.findIndex(p => p.id === id);
  if (idx === -1) return;
  const photo = photos[idx];
  // Revoke object URL for locally uploaded photos to free browser memory
  if (photo.file && photo.url) URL.revokeObjectURL(photo.url);
  photos.splice(idx, 1);
  // Remove from server if backend is available
  fetch(`${serverUrl}/api/photos/${id}`, { method: 'DELETE', headers: authHeaders() }).catch(() => {});
  // Remove map marker if present
  if (mapMarkers[id]) {
    mapMarkers[id].marker.setMap(null);
    mapMarkers[id].infoWindow?.close();
    delete mapMarkers[id];
  }
  // If the deleted photo was selected in the sidebar, clear it
  if (selectedLocation) {
    const remaining = photos.filter(p => p.status === 'done' && p.aiData.location === selectedLocation);
    if (!remaining.length) selectedLocation = null;
    updateLocationList();
  }
  render();
}

// ─────────────────────────────────────────────────────────────────────────────
// Database — load, save, update, delete
// ─────────────────────────────────────────────────────────────────────────────
async function loadSavedPhotos() {
  try {
    const res  = await fetch(`${serverUrl}/api/photos`);
    const rows = await res.json();
    if (!Array.isArray(rows)) return;

    rows.forEach(row => {
      // Avoid duplicates if user already uploaded the same photo this session
      if (photos.find(p => p.id === row.id)) return;

      const photo = {
        id:             row.id,
        name:           row.name,
        // Thumbnail stored as base64; reconstruct a displayable URL
        url:            `data:image/jpeg;base64,${row.thumbnail}`,
        file:           null,   // no File object for saved photos
        status:         'done',
        locationSource: row.location_source || 'ai',
        gpsCoords:      (row.gps_lat && row.gps_lng) ? [row.gps_lat, row.gps_lng] : null,
        fromDB:         true,
        likes:          row.likes || 0,
        pinned:         row.pinned || false,
        rating:         row.rating ?? null,
        tier:           row.tier || null,
        eloScore:       row.elo_score ?? 1500,
        userSubmitted:  row.user_submitted || false,
        aiData: {
          paintingName:   row.painting_name  || '',
          artist:         row.artist         || '',
          location:       row.location       || '',
          country:        row.country        || '',
          style:          row.style          || '',
          medium:         row.medium         || '',
          period:         row.period         || '',
          confidence:     row.confidence     ?? 75,
          description:    row.description    || '',
          artistHint:     row.artist_hint    || '',
          manuallyEdited: row.manually_edited || false,
          model:          row.ai_model       || 'claude-opus-4-6'
        }
      };
      photos.push(photo);
    });

    isLoading = false;
    render();
  } catch (err) {
    console.warn('Could not load saved photos:', err.message);
    isLoading = false;
    render();
  }
}

// Shared image decode → resize → JPEG export pipeline.
// heic2any handles HEIC/HEIF in all browsers; createImageBitmap handles everything else.
async function compressAndConvert(file, { maxDimension = 1920, quality = 0.85 } = {}) {
  // 0. Pre-convert HEIC/HEIF → JPEG blob using heic2any (works in Chrome, Firefox, Edge, Safari)
  const isHeic = file.type === 'image/heic' || file.type === 'image/heif' ||
                 /\.(heic|heif)$/i.test(file.name);
  if (isHeic) {
    try {
      const converted = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.95 });
      file = Array.isArray(converted) ? converted[0] : converted;
    } catch (e) {
      throw new Error('Could not decode this HEIC file. Please try saving it as JPEG and uploading again.');
    }
  }

  // 1. Decode
  let source;
  try {
    source = await createImageBitmap(file);
  } catch (_) {
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(
        'Could not decode this image format. Please try saving it as JPEG and uploading again.'
      )); };
      img.src = url;
    });
  }

  // 2. Scale to fit within maxDimension
  const srcW  = source.width  || source.naturalWidth;
  const srcH  = source.height || source.naturalHeight;
  const scale = Math.min(1, maxDimension / Math.max(srcW, srcH));
  const outW  = Math.round(srcW * scale);
  const outH  = Math.round(srcH * scale);

  // 3. Draw onto canvas
  const canvas = document.createElement('canvas');
  canvas.width  = outW;
  canvas.height = outH;
  canvas.getContext('2d').drawImage(source, 0, 0, outW, outH);
  if (source.close) source.close();

  // 4. Export as JPEG blob → base64
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('Image export failed.');

  const base64 = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = () => resolve(r.result.split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });

  return { base64, mediaType: 'image/jpeg' };
}

// Thumbnail variant: smaller footprint for DB storage / gallery cards
async function compressThumbnail(file) {
  try {
    const { base64 } = await compressAndConvert(file, { maxDimension: 900, quality: 0.82 });
    return base64;
  } catch (_) {
    return null;
  }
}

async function savePhotoToDB(photo) {
  if (!photo.file) return; // already came from DB
  try {
    const thumbnail = await compressThumbnail(photo.file);
    if (!thumbnail) return;
    await fetch(`${serverUrl}/api/photos`, {
      method:  'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        id:             photo.id,
        name:           photo.name,
        thumbnail,
        aiData:         photo.aiData,
        locationSource: photo.locationSource,
        gpsCoords:      photo.gpsCoords || null
      })
    });
  } catch (err) {
    console.warn('Could not save photo to DB:', err.message);
  }
}

async function updatePhotoDB(photo) {
  try {
    await fetch(`${serverUrl}/api/photos/${photo.id}`, {
      method:  'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ aiData: photo.aiData })
    });
  } catch (err) {
    console.warn('Could not update photo in DB:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXIF GPS extraction
// ─────────────────────────────────────────────────────────────────────────────
async function extractGPS(file) {
  try {
    const gps = await exifr.gps(file);
    if (gps && typeof gps.latitude === 'number' && typeof gps.longitude === 'number') {
      return [gps.latitude, gps.longitude];
    }
  } catch (_) {}
  return null;
}

// Device location — cached as a Promise so concurrent calls share the same
// in-flight request (no duplicate browser permission prompts).
// After DEVICE_LOCATION_TTL milliseconds a fresh position is requested, so
// photos taken at different venues within the same session get accurate coords.
const DEVICE_LOCATION_TTL      = 10 * 60 * 1000;  // 10 minutes
let   _deviceLocationPromise   = null;
let   _deviceLocationTimestamp = 0;

async function getDeviceLocation() {
  const now = Date.now();
  // Return the cached promise if it was created within the TTL window
  if (_deviceLocationPromise && (now - _deviceLocationTimestamp) < DEVICE_LOCATION_TTL) {
    return _deviceLocationPromise;
  }
  // Geolocation requires a secure context (HTTPS or localhost).
  // Chrome silently errors without a prompt on plain HTTP — detect early.
  if (!navigator.geolocation || !window.isSecureContext) {
    _deviceLocationPromise   = Promise.resolve(null);
    _deviceLocationTimestamp = now;
    return null;
  }
  // Cache the Promise immediately so any concurrent callers get the same
  // in-flight request rather than triggering a second permission prompt.
  _deviceLocationTimestamp = now;
  _deviceLocationPromise   = new Promise(resolve => {
    Promise.race([
      new Promise((res, rej) =>
        navigator.geolocation.getCurrentPosition(res, rej, {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 300000   // reuse an OS-level cached fix up to 5 min old
        })
      ),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000))
    ])
    .then(pos => resolve([pos.coords.latitude, pos.coords.longitude]))
    .catch(() => {
      // Don't cache failures — clear so the next upload can try again
      // (e.g. user denied then re-enables permission in Chrome settings)
      _deviceLocationPromise   = null;
      _deviceLocationTimestamp = 0;
      resolve(null);
    });
  });
  return _deviceLocationPromise;
}

const reverseGeocodeCache = {};
async function reverseGeocode(lat, lng) {
  const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  if (reverseGeocodeCache[key]) return reverseGeocodeCache[key];

  // ── 1. Try Google Places Nearby Search — venue-aware and accurate ─────────
  // Searches within 100 m for museums, galleries, concert halls, auction houses,
  // arts centres, and performing arts theatres. Falls back to Nominatim if no
  // matching place is found (e.g. outdoor murals, street art, etc.).
  if (serverUrl) {
    try {
      const res   = await fetch(`${serverUrl}/api/reverse-geocode-places?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`);
      const data  = await res.json();
      const place = data.places?.[0];
      if (place?.displayName?.text) {
        const countryComp = (place.addressComponents || [])
          .find(c => c.types?.includes('country'));
        const result = {
          name:    place.displayName.text,
          country: countryComp?.longText || ''
        };
        reverseGeocodeCache[key] = result;
        return result;
      }
    } catch (_) {}
  }

  // ── 2. Fall back to Nominatim ─────────────────────────────────────────────
  // Field priority: named cultural venues first; a.amenity covers arts_centre,
  // concert_hall, theatre, and auction_house OSM tags; a.building is last
  // resort before the city/country generic fallback.
  try {
    const res  = await fetch(`${serverUrl}/api/reverse-geocode?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`);
    const data = await res.json();
    if (data && data.address) {
      const a = data.address;
      const name = a.museum || a.gallery || a.attraction ||
                   a.amenity || a.historic || a.tourism ||
                   a.leisure || a.building ||
                   [a.city || a.town || a.village, a.country].filter(Boolean).join(', ');
      const result = {
        name:    name || data.display_name || 'Unknown Location',
        country: a.country || ''
      };
      reverseGeocodeCache[key] = result;
      return result;
    }
  } catch (_) {}
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude API Analysis
// ─────────────────────────────────────────────────────────────────────────────
function enqueueAnalysis(photo) {
  analysisQueue = analysisQueue
    .then(() => analysePhoto(photo))
    .catch(err => console.error('Queue error:', err));
}

async function analysePhoto(photo) {
  photo.status = 'analyzing';
  render();

  try {
    // ── 1. Extract GPS — EXIF first, then live device location as fallback ──
    let gpsCoords = await extractGPS(photo.file);
    let gpsLocation = null;
    if (!gpsCoords) {
      // No EXIF GPS (common when using the browser camera directly).
      // Ask the browser for the device's current position instead.
      gpsCoords = await getDeviceLocation();
    }
    if (gpsCoords) {
      photo.gpsCoords = gpsCoords;
      photo.locationSource = 'gps';
      gpsLocation = await reverseGeocode(gpsCoords[0], gpsCoords[1]);
    } else {
      photo.locationSource = 'ai';
    }

    // ── 2. Build Claude prompts ────────────────────────────────────────────
    const { base64, mediaType } = await compressAndConvert(photo.file, { maxDimension: 1920 });

    const systemPrompt = `Act as a museum curator interested in identifying art, which can include paintings, sculptures, art installations, murals, and street art. For each artwork fed into the API, try to identify the artist that most closely matches the style of the art, the name of the artwork, and the location where the artwork was taken.

Before drawing any conclusions, reason carefully about the visual evidence: examine the brushwork, color palette, composition, subject matter, architectural surroundings, frame style, gallery wall treatment, any visible signage or labels, and stylistic hallmarks of specific artists or movements. Prioritize evidence you can actually see over general assumptions.

Express genuine uncertainty when the evidence is ambiguous — never fabricate a specific artist name or art title without strong visual justification. If you cannot identify the specific artwork or artist, describe the style and the closest likely school or movement instead.`;

    // Build a location instruction for Claude
    const locationInstruction = gpsCoords
      ? `This photo contains GPS metadata: latitude ${gpsCoords[0].toFixed(6)}, longitude ${gpsCoords[1].toFixed(6)}. Using your knowledge of museums, galleries, and art institutions worldwide, determine the most specific and accurate venue name for these coordinates (e.g. "Rijksmuseum, Amsterdam" rather than just "Amsterdam"). A nearby reverse-geocode hint is: "${gpsLocation ? gpsLocation.name : 'unavailable'}". Populate the location and country fields based on your best identification of these GPS coordinates.`
      : `Identify the location from visual clues in the image (gallery architecture, signage, frame styles, wall treatment, etc.).`;

    const userPrompt = `Analyze this artwork photo. ${locationInstruction}

Return a JSON object with EXACTLY these fields (no markdown, raw JSON only):
{
  "paintingName": "The specific title of the artwork if identifiable, or a descriptive title like 'Unknown portrait' if not",
  "artist": "The artist's full name if identifiable, or the closest matching school/movement, e.g. 'Rembrandt van Rijn' or 'School of Caravaggio'",
  "location": "The most specific venue name you can determine — for GPS photos use the coordinates to identify the museum/gallery; for non-GPS photos infer from visual clues. Format: 'Venue Name, City'",
  "country": "Country name",
  "style": "Art style/movement, e.g. 'Dutch Golden Age', 'Impressionism', 'Baroque'",
  "medium": "Medium used, e.g. 'Oil on Canvas', 'Watercolor', 'Bronze Sculpture'",
  "period": "Time period or century, e.g. '17th century', 'Late 19th c.', 'Contemporary'",
  "confidence": <integer 0-100 for confidence in the artwork/artist identification only>,
  "description": "3-4 sentences: (1) key visual clues observed, (2) why this artist/style matches, (3) notable features of the work.",
  "artistHint": "Additional context about the artist — nationality, active period, signature techniques"
}`;

    const response = await fetch(`${serverUrl}/api/analyze`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 800,
        temperature: 0,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: userPrompt }
          ]
        }]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err?.error?.message || `HTTP ${response.status}`);
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '';

    // Extract JSON — handle cases where model wraps in markdown
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Could not parse AI response as JSON.');
    const parsed = JSON.parse(jsonMatch[0]);

    // Normalize Claude's location string to a canonical Google Places name so it
    // matches what the manual-edit Places autocomplete produces.
    const normalized = await normalizeLocation(parsed.location);
    if (normalized) {
      parsed.location = normalized.location;
      if (normalized.country) parsed.country = normalized.country;
      if (normalized.coords)  geocodeCache[normalized.location] = normalized.coords;
    }

    photo.aiData = {
      paintingName: parsed.paintingName || '',
      artist:       parsed.artist       || '',
      // Location is now canonicalized via Google Places (falls back to Claude's value)
      location:     parsed.location  || 'Unknown Location',
      country:      parsed.country   || 'Unknown',
      style:        parsed.style        || 'Unknown Style',
      medium:       parsed.medium       || 'Unknown Medium',
      period:       parsed.period       || 'Unknown Period',
      confidence:   typeof parsed.confidence === 'number' ? parsed.confidence : 75,
      description:  parsed.description  || '',
      artistHint:   parsed.artistHint   || '',
      model:        data.model          || 'claude-haiku',
      locationSource: photo.locationSource || 'ai'
    };
    photo.status = 'done';
    recentlyAddedIds.add(photo.id); // spotlight it at the top of the gallery
    savePhotoToDB(photo); // persist asynchronously — don't block the UI

  } catch (err) {
    photo.status = 'error';
    photo.error  = err.message;
    console.error('Analysis error for', photo.name, ':', err.message);
  }

  render();
}

// Resolve a free-text location string to a canonical Google Places name.
// Returns { location, country, coords } or null if no confident match found.
async function normalizeLocation(locationStr) {
  if (!serverUrl || !locationStr || locationStr === 'Unknown Location') return null;
  try {
    const sessionToken = crypto.randomUUID ? crypto.randomUUID() : String(Math.random());
    const res  = await fetch(`${serverUrl}/api/places?input=${encodeURIComponent(locationStr)}&sessiontoken=${encodeURIComponent(sessionToken)}`);
    const data = await res.json();
    const first = data.suggestions?.[0];
    if (!first?.placePrediction) return null;

    const pred          = first.placePrediction;
    const canonicalName = pred.text?.text || locationStr;
    let country = null;
    let coords  = null;

    if (pred.placeId) {
      const detRes = await fetch(`${serverUrl}/api/place-details?place_id=${encodeURIComponent(pred.placeId)}&sessiontoken=${encodeURIComponent(sessionToken)}`);
      const det    = await detRes.json();
      const countryComp = (det.addressComponents || []).find(c => c.types?.includes('country'));
      if (countryComp) country = countryComp.longText || null;
      if (det.location) coords = [det.location.latitude, det.location.longitude];
    }

    return { location: canonicalName, country, coords };
  } catch {
    return null;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Re-analyze from edit mode — regenerates description/confidence/artistHint
// using whatever the curator has already filled in as confirmed facts
// ─────────────────────────────────────────────────────────────────────────────
async function reanalyzeFromEdit() {
  const p = photos.find(x => x.id === activeModalId);
  if (!p || !adminToken) return;

  const btn    = document.getElementById('reanalyzeBtn');
  const status = document.getElementById('reanalyzeStatus');

  // Read current values from the edit form
  const paintingName = document.getElementById('editPaintingName').value.trim();
  const artist       = document.getElementById('editArtistName').value.trim();
  const location     = document.getElementById('editLocation').value.trim();
  const style        = document.getElementById('editStyle').value.trim();
  const medium       = document.getElementById('editMedium').value.trim();
  const period       = document.getElementById('editPeriod').value.trim();

  // Get image as base64 — prefer original file, fall back to stored thumbnail
  let base64    = null;
  let mediaType = 'image/jpeg';
  if (p.file) {
    ({ base64, mediaType } = await compressAndConvert(p.file, { maxDimension: 1920 }));
  } else if (p.url && p.url.startsWith('data:')) {
    // Stored thumbnail: data:image/jpeg;base64,<data>
    const parts = p.url.split(',');
    base64 = parts[1] || null;
    const mimeMatch = parts[0].match(/data:([^;]+);/);
    if (mimeMatch) mediaType = mimeMatch[1];
  }

  if (!base64) {
    status.style.display = '';
    status.textContent   = '⚠ Could not retrieve image data for re-analysis.';
    return;
  }

  // Show loading state
  btn.disabled  = true;
  btn.innerHTML = `<span class="reanalyze-spinner"></span> Analyzing…`;
  status.style.display = '';
  status.textContent   = 'Sending to Claude — this takes a few seconds…';

  // Build confirmed-facts section for the prompt
  const knownFacts = [
    paintingName && `Painting Name: ${paintingName}`,
    artist       && `Artist: ${artist}`,
    location     && `Location: ${location}`,
    style        && `Art Style: ${style}`,
    medium       && `Medium: ${medium}`,
    period       && `Period: ${period}`,
  ].filter(Boolean).join('\n');

  const userPrompt = `You are an expert museum curator. The following details about this artwork have been confirmed:

${knownFacts || '(no fields confirmed yet — use what you can observe)'}

Using these confirmed facts together with what you can observe in the image, provide:
1. A rich, expert 3–4 sentence description covering: key visual observations, why the style/artist attribution fits, and any notable art-historical significance.
2. A revised confidence score (0–100) for the artist/painting identification — given the confirmed details, this should typically be high.
3. Expanded artist context: nationality, active period, signature techniques, and where this work fits in their oeuvre.
4. Fill in any of the fields below that are currently blank, based on the image and confirmed facts. Do NOT change fields that are already confirmed above.

Return ONLY a valid JSON object with exactly these keys (raw JSON, no markdown fences):
{
  "description": "...",
  "confidence": <integer 0–100>,
  "artistHint": "...",
  "style": "${style   || ''}",
  "medium": "${medium || ''}",
  "period": "${period || ''}"
}`;

  try {
    const res = await fetch(`${serverUrl}/api/analyze`, {
      method:  'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        model:      'claude-opus-4-6',
        max_tokens: 900,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text',  text: userPrompt }
          ]
        }]
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `HTTP ${res.status}`);
    }

    const data = await res.json();
    const text = data.content?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Could not parse AI response as JSON.');
    const parsed = JSON.parse(jsonMatch[0]);

    // Update only the regeneratable fields in the edit form
    // (never overwrite paintingName, artist, location, country — those are confirmed by the curator)
    if (parsed.description) document.getElementById('editDesc').value        = parsed.description;
    if (parsed.artistHint)  document.getElementById('editArtist').value      = parsed.artistHint;

    // Only fill style/medium/period if the form field was blank
    if (!style  && parsed.style)  document.getElementById('editStyle').value  = parsed.style;
    if (!medium && parsed.medium) document.getElementById('editMedium').value = parsed.medium;
    if (!period && parsed.period) document.getElementById('editPeriod').value = parsed.period;

    // Update confidence slider
    if (typeof parsed.confidence === 'number') {
      const conf = Math.max(0, Math.min(100, parsed.confidence));
      document.getElementById('editConfidence').value      = conf;
      document.getElementById('editConfidenceVal').textContent = conf + '%';
    }

    status.style.color   = '#3a7d44';
    status.textContent   = '✓ Description and context updated — review and save when ready.';

  } catch (err) {
    status.style.color = '#c0392b';
    status.textContent = `⚠ Re-analysis failed: ${err.message}`;
    console.error('Re-analyze error:', err);
  }

  btn.disabled  = false;
  btn.innerHTML = '🔄 Re-analyze with AI';
}


// ─────────────────────────────────────────────────────────────────────────────
// Bulk selection
// ─────────────────────────────────────────────────────────────────────────────
function toggleSelectMode() {
  selectMode = !selectMode;
  if (!selectMode) clearSelection();
  document.body.classList.toggle('select-mode', selectMode);
  const btn = document.getElementById('selectModeBtn');
  btn.textContent = selectMode ? '✕ Done' : '☑ Select';
  btn.classList.toggle('active', selectMode);
  render();
}

function handleCardClick(id) {
  if (selectMode && adminToken) {
    toggleCardSelection(id);
  } else {
    openModal(id);
  }
}

function toggleCardSelection(id) {
  if (selectedPhotoIds.has(id)) {
    selectedPhotoIds.delete(id);
  } else {
    selectedPhotoIds.add(id);
  }
  // Update card DOM directly to avoid a full re-render
  document.querySelectorAll(`.photo-card[data-id="${id}"]`).forEach(card => {
    card.classList.toggle('selected', selectedPhotoIds.has(id));
    card.querySelector('.select-checkbox')?.classList.toggle('checked', selectedPhotoIds.has(id));
  });
  updateSelectionBar();
}

function clearSelection() {
  selectedPhotoIds.clear();
  document.querySelectorAll('.photo-card.selected').forEach(c => c.classList.remove('selected'));
  document.querySelectorAll('.select-checkbox.checked').forEach(c => c.classList.remove('checked'));
  updateSelectionBar();
}

function updateSelectionBar() {
  const n   = selectedPhotoIds.size;
  const bar = document.getElementById('selectionBar');
  bar.classList.toggle('visible', n > 0 && selectMode);
  document.getElementById('selectionCount').textContent = `${n} photo${n === 1 ? '' : 's'} selected`;
}

function openBulkEditModal() {
  if (!selectedPhotoIds.size) return;
  const n = selectedPhotoIds.size;
  document.getElementById('bulkEditCount').textContent = `${n} photo${n === 1 ? '' : 's'}`;
  document.getElementById('bulkLocation').value = '';
  document.getElementById('bulkCountry').value  = '';
  closeBulkPlacesDropdown();
  document.getElementById('bulkEditModalBg').classList.add('open');
}

function closeBulkEditModal() {
  document.getElementById('bulkEditModalBg').classList.remove('open');
  const btn = document.getElementById('bulkSaveBtn');
  btn.disabled    = false;
  btn.textContent = 'Save Changes';
}

function bulkBgClick(e) {
  if (e.target === document.getElementById('bulkEditModalBg')) closeBulkEditModal();
}

async function saveBulkEdit() {
  const newLocation = document.getElementById('bulkLocation').value.trim();
  const newCountry  = document.getElementById('bulkCountry').value.trim();
  if (!newLocation && !newCountry) { closeBulkEditModal(); return; }

  const btn = document.getElementById('bulkSaveBtn');
  btn.disabled    = true;
  btn.textContent = 'Saving…';

  await Promise.all([...selectedPhotoIds].map(id => {
    const photo = photos.find(p => p.id === id);
    if (!photo?.aiData) return Promise.resolve();
    if (newLocation) photo.aiData.location = newLocation;
    if (newCountry)  photo.aiData.country  = newCountry;
    photo.aiData.manuallyEdited = true;
    return updatePhotoDB(photo);
  }));

  closeBulkEditModal();
  clearSelection();
  toggleSelectMode();
  render();
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────
function render() {
  updateStats();

  const mapView = document.getElementById('mapView');
  const content = document.getElementById('content');
  const loading = document.getElementById('loadingScreen');

  loading.classList.toggle('hidden', !isLoading);

  if (!photos.length) {
    content.innerHTML = '';
    mapView.classList.remove('active');
    return;
  }

  const donephotos = photos.filter(p => p.status === 'done');

  if (currentFilter === 'submissions') {
    mapView.classList.remove('active');
    content.style.display = '';
    renderSubmissions(content);
    return;
  }

  if (currentFilter === 'location' && donephotos.length > 0) {
    mapView.classList.add('active');
    content.style.display = 'none';
    renderPendingErrors(content);
    updateMap();
  } else {
    mapView.classList.remove('active');
    content.style.display = '';
    if (currentFilter === 'style') {
      renderGrouped(content, 'style', '🎨', p => p.aiData.style);
    } else if (currentFilter === 'artist') {
      renderGrouped(content, 'artist', '🖌️', p => p.aiData.artist || 'Unknown Artist');
    } else if (currentFilter === 'all' && currentAllMode === 'flat') {
      renderFlat(content);
    } else {
      renderGrouped(content, 'location', '📍', p => p.aiData.location);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Submissions (admin review panel)
// ─────────────────────────────────────────────────────────────────────────────
async function loadSubmissions() {
  if (!adminToken || !serverUrl) return;
  try {
    const res  = await fetch(`${serverUrl}/api/submissions`, { headers: authHeaders() });
    if (!res.ok) return;
    submissions = await res.json();
    updateSubmissionsBadge();
    if (currentFilter === 'submissions') render();
  } catch (err) {
    console.warn('Could not load submissions:', err.message);
  }
}

function updateSubmissionsBadge() {
  const badge = document.getElementById('submissionsBadge');
  if (!badge) return;
  if (submissions.length > 0) {
    badge.textContent = submissions.length;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

function renderSubmissions(container) {
  if (!adminToken) { container.innerHTML = ''; return; }
  if (submissions.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding:60px 24px; color:#999;">
        <div style="font-size:36px; margin-bottom:12px">📬</div>
        <div style="font-size:15px; font-weight:600; color:#555; margin-bottom:6px">No pending submissions</div>
        <div style="font-size:13px">Submissions from the public will appear here for review.</div>
      </div>`;
    return;
  }
  container.innerHTML = `
    <div style="padding: 24px 0 12px; display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
      <h2 style="font-family:'Playfair Display',serif; font-size:20px; font-weight:600; color:#111;">
        Pending Submissions
      </h2>
      <span style="font-size:12px; background:#fde8e8; color:#8f0101; border-radius:20px; padding:3px 10px; font-weight:600;">
        ${submissions.length} awaiting review
      </span>
    </div>
    <div style="display:flex; flex-direction:column; gap:16px; padding-bottom:40px;">
      ${submissions.map(submissionCard).join('')}
    </div>`;
}

function submissionCard(s) {
  const thumb = s.thumbnail ? `data:image/jpeg;base64,${s.thumbnail}` : '';
  const conf  = s.confidence != null ? s.confidence : '–';
  const confPct = s.confidence != null ? s.confidence + '%' : '0%';
  const ago = (() => {
    const d = new Date(s.created_at);
    const diff = Date.now() - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return d.toLocaleDateString();
  })();

  return `<div id="subcard-${s.id}" class="sub-card" style="
    background:#fff; border-radius:12px; border:1px solid #e0dbd5;
    display:grid; overflow:hidden;
    box-shadow:0 1px 4px rgba(0,0,0,0.06);">
    <!-- Thumbnail -->
    <div class="sub-card-thumb" style="background:#111; display:flex; align-items:center; justify-content:center; min-height:180px; max-height:260px; overflow:hidden;">
      ${thumb ? `<img src="${thumb}" alt="" style="width:100%; height:100%; object-fit:cover; display:block;" />` : '<span style="color:#555;font-size:32px">🖼️</span>'}
    </div>
    <!-- Details -->
    <div style="padding:20px 22px; display:flex; flex-direction:column; gap:0;">
      <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:12px; flex-wrap:wrap;">
        <div>
          <div style="font-family:'Playfair Display',serif; font-size:17px; font-weight:600; color:#111; margin-bottom:2px;">
            ${escHtml(s.painting_name || 'Untitled')}
          </div>
          <div style="font-size:13px; color:#555;">${escHtml(s.artist || 'Unknown Artist')}</div>
        </div>
        <div style="font-size:11px; color:#aaa; white-space:nowrap;">${ago}</div>
      </div>

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px 16px; font-size:12px; color:#666; margin-bottom:12px;">
        <div><span style="color:#aaa;text-transform:uppercase;letter-spacing:.6px;font-size:10px;font-weight:600">Location</span><br>${escHtml(s.location || '–')}</div>
        <div><span style="color:#aaa;text-transform:uppercase;letter-spacing:.6px;font-size:10px;font-weight:600">Style</span><br>${escHtml(s.style || '–')}</div>
        <div><span style="color:#aaa;text-transform:uppercase;letter-spacing:.6px;font-size:10px;font-weight:600">Medium</span><br>${escHtml(s.medium || '–')}</div>
        <div><span style="color:#aaa;text-transform:uppercase;letter-spacing:.6px;font-size:10px;font-weight:600">Period</span><br>${escHtml(s.period || '–')}</div>
      </div>

      ${s.description ? `<div style="font-size:12px; color:#555; line-height:1.55; margin-bottom:12px; font-style:italic;">"${escHtml(s.description.slice(0, 180))}${s.description.length > 180 ? '…' : ''}"</div>` : ''}

      <!-- Confidence bar -->
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:12px;">
        <div style="flex:1; height:5px; background:#e8e3de; border-radius:3px; overflow:hidden;">
          <div style="height:100%; width:${confPct}; background:linear-gradient(90deg,#e05c2e,#8f0101); border-radius:3px;"></div>
        </div>
        <span style="font-size:11px; font-weight:700; color:#8f0101; min-width:30px; text-align:right;">${conf}${s.confidence != null ? '%' : ''}</span>
      </div>

      <!-- Submitter info -->
      <div style="font-size:12px; color:#888; margin-bottom:${s.note ? '8px' : '16px'};">
        Submitted by <strong style="color:#555">${escHtml(s.submitter_name)}</strong>
        &lt;${escHtml(s.submitter_email)}&gt;
      </div>
      ${s.note ? `<div style="font-size:12px; color:#777; background:#f8f6f2; border-radius:6px; padding:8px 12px; margin-bottom:16px; line-height:1.5;"><em>Note: ${escHtml(s.note)}</em></div>` : ''}

      <!-- Action buttons -->
      <div style="display:flex; gap:10px; margin-top:auto;">
        <button onclick="approveSubmission('${s.id}')"
          style="flex:1; padding:9px; background:#8f0101; color:#fff; border:none; border-radius:8px;
                 font-size:13px; font-weight:600; font-family:inherit; cursor:pointer; transition:background .2s;"
          onmouseover="this.style.background='#7a0101'" onmouseout="this.style.background='#8f0101'">
          ✓ Approve & Add to Gallery
        </button>
        <button onclick="rejectSubmission('${s.id}')"
          style="padding:9px 16px; background:none; color:#999; border:1.5px solid #d4cfc9;
                 border-radius:8px; font-size:13px; font-weight:500; font-family:inherit; cursor:pointer; transition:all .2s;"
          onmouseover="this.style.borderColor='#c0392b';this.style.color='#c0392b'"
          onmouseout="this.style.borderColor='#d4cfc9';this.style.color='#999'">
          ✕ Reject
        </button>
      </div>
    </div>
  </div>`;
}

async function approveSubmission(id) {
  const card = document.getElementById('subcard-' + id);
  if (card) card.style.opacity = '0.5';
  try {
    const res = await fetch(`${serverUrl}/api/submissions/${id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ action: 'approve' })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error || `HTTP ${res.status}`);
    }
    submissions = submissions.filter(s => s.id !== id);
    updateSubmissionsBadge();
    // Reload photos so the approved photo appears in the gallery
    await loadSavedPhotos();
    if (currentFilter === 'submissions') render();
  } catch (err) {
    if (card) card.style.opacity = '';
    alert('Could not approve submission: ' + err.message);
  }
}

async function rejectSubmission(id) {
  if (!confirm('Reject this submission? This cannot be undone.')) return;
  const card = document.getElementById('subcard-' + id);
  if (card) card.style.opacity = '0.5';
  try {
    const res = await fetch(`${serverUrl}/api/submissions/${id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ action: 'reject' })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error || `HTTP ${res.status}`);
    }
    submissions = submissions.filter(s => s.id !== id);
    updateSubmissionsBadge();
    if (currentFilter === 'submissions') render();
  } catch (err) {
    if (card) card.style.opacity = '';
    alert('Could not reject submission: ' + err.message);
  }
}

function renderPendingErrors(container) {
  const pending = photos.filter(p => p.status === 'analyzing' || p.status === 'queue');
  const errors  = photos.filter(p => p.status === 'error');
  let html = '';
  if (pending.length) {
    html += `<div class="location-group" style="margin-top:16px">
      <div class="location-header"><span class="location-icon">⏳</span>
      <span class="location-name">Analyzing…</span>
      <span class="location-sub">${pending.length} photo${pending.length>1?'s':''}</span></div>
      <div class="photo-grid">${pending.map(photoCard).join('')}</div></div>`;
  }
  if (errors.length) {
    html += `<div class="location-group" style="margin-top:16px">
      <div class="location-header"><span class="location-icon">⚠️</span>
      <span class="location-name" style="color:#c0392b">Analysis Failed</span>
      <span class="location-sub">${errors.length} photo${errors.length>1?'s':''}</span></div>
      <div class="photo-grid">${errors.map(photoCard).join('')}</div></div>`;
  }
  container.innerHTML = html;
  container.style.display = html ? '' : 'none';
}

function renderGrouped(container, _key, icon, keyFn) {
  const analyzing = photos.filter(p => p.status === 'analyzing');
  const queued    = photos.filter(p => p.status === 'queue');
  const errors    = photos.filter(p => p.status === 'error');
  const done      = photos.filter(p => p.status === 'done');

  // ── Sort photos within each group ────────────────────────────────────────
  function sortedPhotos(arr) {
    const a = [...arr];
    switch (currentSort) {
      case 'oldest':
        return a.reverse();
      case 'liked':
        return a.sort((x, y) => (y.rating ?? 0) - (x.rating ?? 0));
      case 'confidence':
        return a.sort((x, y) => (y.aiData?.confidence || 0) - (x.aiData?.confidence || 0));
      case 'title':
        return a.sort((x, y) => (x.aiData?.paintingName || x.name).localeCompare(y.aiData?.paintingName || y.name));
      case 'artist':
        return a.sort((x, y) => (x.aiData?.artist || '').localeCompare(y.aiData?.artist || ''));
      default: // newest — DB already returns newest first
        return a;
    }
  }

  const groups = {};
  done.forEach(p => {
    const k = keyFn(p);
    if (!groups[k]) groups[k] = [];
    groups[k].push(p);
  });

  // ── Sort groups ───────────────────────────────────────────────────────────
  function sortedGroups(entries) {
    switch (currentSort) {
      case 'liked':
        // Groups with the highest-rated photo first
        return entries.sort(([, a], [, b]) => {
          const maxA = Math.max(...a.map(p => p.rating ?? 0));
          const maxB = Math.max(...b.map(p => p.rating ?? 0));
          return maxB - maxA;
        });
      case 'confidence':
        // Groups with the highest average confidence first
        return entries.sort(([, a], [, b]) => {
          const avgA = a.reduce((s, p) => s + (p.aiData?.confidence || 0), 0) / a.length;
          const avgB = b.reduce((s, p) => s + (p.aiData?.confidence || 0), 0) / b.length;
          return avgB - avgA;
        });
      case 'oldest':
        // Group whose oldest photo was added first (last in array = oldest from DB)
        return entries.sort(([, a], [, b]) => {
          const idxA = done.indexOf(a[a.length - 1]);
          const idxB = done.indexOf(b[b.length - 1]);
          return idxB - idxA;
        });
      case 'newest':
        // Group whose most recently added photo was added first
        return entries.sort(([, a], [, b]) => {
          const idxA = done.indexOf(a[0]);
          const idxB = done.indexOf(b[0]);
          return idxA - idxB;
        });
      default:
        // title, artist → alphabetical by group name
        return entries.sort(([a], [b]) => a.localeCompare(b));
    }
  }

  let html = '';

  // ── Just Added spotlight (photos that finished analysis this session) ────────
  const justAdded = done.filter(p => recentlyAddedIds.has(p.id));
  if (justAdded.length > 0) {
    const sub = justAdded.length === 1
      ? '1 photo · freshly processed'
      : `${justAdded.length} photos · freshly processed`;
    html += `<div class="just-added-section">
      <div class="just-added-header">
        <span class="just-added-header-icon">✨</span>
        <span class="just-added-header-title">Just Added</span>
        <span class="just-added-header-sub">${sub}</span>
        <button class="just-added-dismiss" onclick="dismissJustAdded()" title="Dismiss">×</button>
      </div>
      <div class="just-added-grid-wrap">
        <div class="photo-grid">
          ${justAdded.map(p => photoCard(p, false, true)).join('')}
        </div>
      </div>
    </div>`;
  }

  if (analyzing.length || queued.length) {
    const pending = [...analyzing, ...queued];
    html += `<div class="location-group">
      <div class="location-header">
        <span class="location-icon">⏳</span>
        <span class="location-name">Analyzing with Claude AI</span>
        <span class="location-sub">${pending.length} photo${pending.length > 1 ? 's' : ''}</span>
      </div>
      <div class="photo-grid">${pending.map(photoCard).join('')}</div>
    </div>`;
  }

  if (errors.length) {
    html += `<div class="location-group">
      <div class="location-header">
        <span class="location-icon">⚠️</span>
        <span class="location-name" style="color:#c0392b">Analysis Failed</span>
        <span class="location-sub">${errors.length} photo${errors.length > 1 ? 's' : ''}</span>
      </div>
      <div class="photo-grid">${errors.map(photoCard).join('')}</div>
    </div>`;
  }

  sortedGroups(Object.entries(groups)).forEach(([groupName, items]) => {
    const sorted = sortedPhotos(items);

    // Build a sort-aware subtitle for each group header
    let sortNote = '';
    if (currentSort === 'liked') {
      const top = Math.max(...items.map(p => p.rating ?? 0));
      sortNote = top > 0 ? ` · top rating ${top.toFixed(1)}` : '';
    } else if (currentSort === 'confidence') {
      const avg = Math.round(items.reduce((s, p) => s + (p.aiData?.confidence || 0), 0) / items.length);
      sortNote = ` · avg ${avg}% confidence`;
    }

    const sub = _key === 'location'
      ? `${escHtml(items[0].aiData.country)} · ${items.length} photo${items.length > 1 ? 's' : ''}${sortNote}`
      : _key === 'artist'
      ? `${escHtml(items[0].aiData.period || '')} · ${items.length} photo${items.length > 1 ? 's' : ''}${sortNote}`
      : `${items.length} photo${items.length > 1 ? 's' : ''}${sortNote}`;

    // Put any pinned photo first in the group, then apply normal sort order for the rest
    const pinnedFirst = [
      ...sorted.filter(p => p.pinned),
      ...sorted.filter(p => !p.pinned)
    ];

    html += `<div class="location-group">
      <div class="location-header">
        <span class="location-name">${escHtml(groupName)}</span>
        <span class="location-sub">${sub}</span>
      </div>
      <div class="photo-grid">${pinnedFirst.map((p, i) => photoCard(p, i === 0 && pinnedFirst.length >= 3)).join('')}</div>
    </div>`;
  });

  container.innerHTML = html;
}

function dismissJustAdded() {
  recentlyAddedIds.clear();
  render();
}

// ─────────────────────────────────────────────────────────────────────────────
// Flat (ungrouped) renderer — used by "All › Ungrouped"
// ─────────────────────────────────────────────────────────────────────────────
function sortAllPhotos(arr) {
  const a = [...arr];
  switch (currentSort) {
    case 'oldest':     return a.reverse();
    case 'liked':      return a.sort((x, y) => (y.rating ?? 0) - (x.rating ?? 0));
    case 'confidence': return a.sort((x, y) => (y.aiData?.confidence || 0) - (x.aiData?.confidence || 0));
    case 'title':      return a.sort((x, y) => (x.aiData?.paintingName || x.name).localeCompare(y.aiData?.paintingName || y.name));
    case 'artist':     return a.sort((x, y) => (x.aiData?.artist || '').localeCompare(y.aiData?.artist || ''));
    default:           return a; // newest — DB already returns newest first
  }
}

function renderFlat(container) {
  const analyzing = photos.filter(p => p.status === 'analyzing');
  const queued    = photos.filter(p => p.status === 'queue');
  const errors    = photos.filter(p => p.status === 'error');
  const done      = photos.filter(p => p.status === 'done');

  let html = '';

  // Just Added spotlight
  const justAdded = done.filter(p => recentlyAddedIds.has(p.id));
  if (justAdded.length > 0) {
    const sub = justAdded.length === 1 ? '1 photo · freshly processed' : `${justAdded.length} photos · freshly processed`;
    html += `<div class="just-added-section">
      <div class="just-added-header">
        <span class="just-added-header-icon">✨</span>
        <span class="just-added-header-title">Just Added</span>
        <span class="just-added-header-sub">${sub}</span>
        <button class="just-added-dismiss" onclick="dismissJustAdded()" title="Dismiss">×</button>
      </div>
      <div class="just-added-grid-wrap">
        <div class="photo-grid">
          ${justAdded.map(p => photoCard(p, false, true)).join('')}
        </div>
      </div>
    </div>`;
  }

  // Analyzing / queued
  if (analyzing.length || queued.length) {
    const pending = [...analyzing, ...queued];
    html += `<div class="location-group">
      <div class="location-header">
        <span class="location-icon">⏳</span>
        <span class="location-name">Analyzing with Claude AI</span>
        <span class="location-sub">${pending.length} photo${pending.length > 1 ? 's' : ''}</span>
      </div>
      <div class="photo-grid">${pending.map(photoCard).join('')}</div>
    </div>`;
  }

  // Errors
  if (errors.length) {
    html += `<div class="location-group">
      <div class="location-header">
        <span class="location-icon">⚠️</span>
        <span class="location-name" style="color:#c0392b">Analysis Failed</span>
        <span class="location-sub">${errors.length} photo${errors.length > 1 ? 's' : ''}</span>
      </div>
      <div class="photo-grid">${errors.map(photoCard).join('')}</div>
    </div>`;
  }

  // Flat grid — all done photos sorted by current sort option
  const sorted = sortAllPhotos(done);
  if (sorted.length) {
    html += `<div class="photo-grid">${sorted.map((p, i) => photoCard(p, i === 0)).join('')}</div>`;
  }

  container.innerHTML = html;
}

function photoCard(p, featured = false, isNew = false) {
  let overlay = '';
  if (p.status === 'analyzing') {
    overlay = `<div class="status-overlay overlay-analyzing"><div class="spinner"></div><span>Claude is analyzing…</span></div>`;
  } else if (p.status === 'queue') {
    overlay = `<div class="status-overlay overlay-queue"><span>⏳</span><span>Queued</span></div>`;
  } else if (p.status === 'error') {
    overlay = `<div class="status-overlay overlay-error"><span>⚠️</span><span>Analysis failed</span></div>`;
  }

  // GPS overlay badge — appears on the photo image
  const gpsBadge = (p.status === 'done' && p.locationSource === 'gps')
    ? `<div class="card-gps-badge">GPS</div>` : '';
  const newBadge       = isNew          ? `<div class="new-badge">NEW</div>` : '';
  const communityBadge = p.userSubmitted ? `<div class="card-community-badge">Community</div>` : '';

  const cardTitle = (p.status === 'done' && p.aiData?.paintingName) ? p.aiData.paintingName : p.name;
  let infoHtml = `<div class="photo-info"><div class="photo-title">${escHtml(cardTitle)}</div>`;

  if (p.status === 'done' && p.aiData) {
    const d = p.aiData;
    const confClass = d.confidence >= 80 ? 'confidence-high' : d.confidence >= 55 ? 'confidence-med' : 'confidence-low';
    const editedBadge = d.manuallyEdited ? `<span class="manually-edited-badge">✎ edited</span>` : '';
    const artistHtml = d.artist ? `<div class="card-artist">${escHtml(d.artist)}</div>` : '';
    // Movement · medium on one italic line
    const movementHtml = d.style ? `<div class="card-movement">${escHtml(d.style)}${d.medium ? ' · ' + escHtml(d.medium) : ''}</div>` : '';
    const locationHtml = d.location ? `<div class="card-location">${escHtml(d.location)}</div>` : '';
    infoHtml += `
      ${artistHtml}
      ${movementHtml}
      ${locationHtml}
      <div class="photo-meta">
        <div class="photo-meta-left">
          <span>${escHtml(d.period)}${editedBadge}</span>
        </div>
        <div class="photo-meta-right">
          <span class="${confClass}">✓ ${d.confidence}%</span>
          ${p.rating != null ? `<span class="card-rating${p.tier ? ' tier-' + p.tier : ''}">${p.rating % 1 === 0 ? p.rating : p.rating.toFixed(1)}</span>` : ''}
          <button class="like-btn${likedIds.has(p.id) ? ' liked' : ''}"
                  onclick="event.stopPropagation(); likePhoto('${p.id}', event)">
            <span class="heart">♡</span>${p.likes || 0}
          </button>
        </div>
      </div>`;
  } else if (p.status === 'error') {
    infoHtml += `<p class="error-msg">Error: ${escHtml(p.error || 'Unknown error')}</p>`;
  }

  infoHtml += '</div>';

  const clickable = p.status === 'done';
  const featuredClass  = featured ? ' featured' : '';
  const pinnedClass    = p.pinned  ? ' pinned'   : '';
  const selectedClass  = (selectMode && selectedPhotoIds.has(p.id)) ? ' selected' : '';
  const pinLabel       = p.pinned  ? '📌' : '📍';
  const pinTitle       = p.pinned  ? 'Unpin (restore normal order)' : 'Pin as featured card for this group';
  return `<div class="photo-card ${p.status}${featuredClass}${pinnedClass}${selectedClass}" data-id="${p.id}" ${clickable ? `onclick="handleCardClick('${p.id}')"` : ''}>
    ${adminToken ? `<button type="button" class="delete-btn" title="Remove photo" onclick="event.stopPropagation(); deletePhoto('${p.id}')">✕</button>` : ''}
    ${adminToken ? `<button type="button" class="pin-btn" title="${pinTitle}" onclick="event.stopPropagation(); pinPhoto('${p.id}', ${!p.pinned})">${pinLabel}</button>` : ''}
    ${adminToken ? `<div class="select-checkbox${selectedPhotoIds.has(p.id) ? ' checked' : ''}" onclick="event.stopPropagation(); toggleCardSelection('${p.id}')">✓</div>` : ''}
    <div class="card-img-wrap">
      <img src="${p.url}" alt="${escHtml(p.name)}" loading="lazy" />
      ${p.pinned ? `<div class="pinned-badge">★ FEATURED</div>` : ''}
      ${communityBadge}
      ${gpsBadge}
      ${newBadge}
      ${overlay}
    </div>
    ${infoHtml}
  </div>`;
}

function updateStats() {
  const done = photos.filter(p => p.status === 'done');
  document.getElementById('totalCount').textContent    = photos.length;
  document.getElementById('locationCount').textContent = new Set(done.map(p => p.aiData.location)).size;
  document.getElementById('styleCount').textContent    = new Set(done.map(p => p.aiData.style)).size;
  document.getElementById('gpsCount').textContent      = done.filter(p => p.locationSource === 'gps').length;

  const pending = photos.filter(p => p.status === 'queue' || p.status === 'analyzing').length;
  document.getElementById('queueStatus').textContent = pending ? `⚡ ${pending} analyzing…` : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Filter & Sort
// ─────────────────────────────────────────────────────────────────────────────
function setFilter(filter, btn) {
  currentFilter = filter;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  // Show the grouped/ungrouped toggle only for the "All" view
  const toggle = document.getElementById('groupingToggle');
  if (toggle) toggle.style.display = (filter === 'all') ? '' : 'none';
  render();
  if (filter === 'location' && googleMap) {
    setTimeout(() => google.maps.event.trigger(googleMap, 'resize'), 50);
  }
}

function setAllMode(mode) {
  currentAllMode = mode;
  document.getElementById('groupedBtn').classList.toggle('active', mode === 'grouped');
  document.getElementById('flatBtn').classList.toggle('active', mode === 'flat');
  render();
}

function setSort(value) {
  currentSort = value;
  render();
}

// ─────────────────────────────────────────────────────────────────────────────
// Modal
// ─────────────────────────────────────────────────────────────────────────────
let activeModalId = null;

function openModal(id) {
  const p = photos.find(x => x.id === id);
  if (!p || p.status !== 'done') return;
  activeModalId = id;

  refreshModalView(p);

  // Always start in view mode
  document.getElementById('viewMode').style.display = '';
  document.getElementById('editMode').style.display = 'none';

  document.getElementById('modalBg').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function refreshModalView(p) {
  const d = p.aiData;
  document.getElementById('modalImg').src = p.url;
  const displayTitle = d.paintingName || p.name;
  document.getElementById('modalTitle').innerHTML =
    escHtml(displayTitle) + (d.manuallyEdited ? ' <span class="manually-edited-badge">✎ edited</span>' : '');

  document.getElementById('modalTags').innerHTML = `
    <span class="tag location" style="font-size:13px">📍 ${escHtml(d.location)}</span>
    <span class="tag style"    style="font-size:13px">🎨 ${escHtml(d.style)}</span>
    <span class="tag medium"   style="font-size:13px">🖌️ ${escHtml(d.medium)}</span>
  `;
  document.getElementById('modalDesc').textContent = d.description;

  const confClass = d.confidence >= 80 ? 'confidence-high' : d.confidence >= 55 ? 'confidence-med' : 'confidence-low';
  document.getElementById('modalDetails').innerHTML = `
    ${d.paintingName ? `<div class="modal-detail" style="grid-column:1/-1"><label>Painting Name</label><span>${escHtml(d.paintingName)}</span></div>` : ''}
    ${d.artist       ? `<div class="modal-detail" style="grid-column:1/-1"><label>Artist</label><span>${escHtml(d.artist)}</span></div>` : ''}
    <div class="modal-detail"><label>Location</label><span>${escHtml(d.location)}</span></div>
    <div class="modal-detail"><label>Country</label><span>${escHtml(d.country)}</span></div>
    <div class="modal-detail"><label>Art Style</label><span>${escHtml(d.style)}</span></div>
    <div class="modal-detail"><label>Medium</label><span>${escHtml(d.medium)}</span></div>
    <div class="modal-detail"><label>Period</label><span>${escHtml(d.period)}</span></div>
    <div class="modal-detail"><label>Confidence</label><span class="${confClass}">${d.confidence}%</span></div>
    ${d.artistHint ? `<div class="modal-detail" style="grid-column:1/-1"><label>Artist Context</label><span>${escHtml(d.artistHint)}</span></div>` : ''}
  `;
  const locSource = p.locationSource === 'gps'
    ? '🛰 Location from GPS metadata'
    : '✦ Location identified by Claude AI';
  const noteText = d.manuallyEdited
    ? `Originally analyzed by ${d.model || 'Claude'} · edited · ${locSource}`
    : `Analyzed by ${d.model || 'Claude'} · ${locSource}`;
  document.getElementById('modalNote').textContent = noteText;

  // ── Rating section ────────────────────────────────────────────────────────
  // Read-only badge — score is set via ELO comparisons on the Top Works page.
  const r = p.rating;
  const tierBit = p.tier ? `<span class="tier-pill ${p.tier}">${TIER_LABELS[p.tier]}</span>` : '';
  const ratingBadgeHtml = r != null
    ? `<span class="modal-rating-badge rated">${r % 1 === 0 ? r : r.toFixed(1)}</span>`
    : `<span class="modal-rating-badge unrated">Not rated</span>`;

  // Like button merged into rating row for compact inline display
  const liked = likedIds.has(p.id);
  const likeCompact = `<button class="modal-like-compact${liked ? ' liked' : ''}" id="modalLikeBtn"
    onclick="likePhoto('${p.id}', event)">${liked ? '♥' : '♡'} ${p.likes || 0}</button>`;

  document.getElementById('modalRating').innerHTML = `
    <div class="modal-rating-row">
      <div class="modal-rating-label">My Rating</div>
      <div style="display:flex;align-items:center;gap:8px">${tierBit}${ratingBadgeHtml}${likeCompact}</div>
    </div>`;

  // Admin-only actions (edit / delete)
  document.getElementById('modalAdminActions').innerHTML = adminToken
    ? `<button class="modal-edit-btn" onclick="startEdit()">✏️ Edit Details</button>
       <button class="modal-delete-btn" onclick="deleteFromModal()">🗑 Delete</button>`
    : '';
}

function startEdit() {
  const p = photos.find(x => x.id === activeModalId);
  if (!p) return;
  const d = p.aiData;

  // Pre-fill edit fields
  document.getElementById('editPaintingName').value = d.paintingName || '';
  document.getElementById('editArtistName').value   = d.artist       || '';
  document.getElementById('editLocation').value     = d.location     || '';
  document.getElementById('editCountry').value      = d.country      || '';
  document.getElementById('editStyle').value        = d.style        || '';
  document.getElementById('editMedium').value       = d.medium       || '';
  document.getElementById('editPeriod').value       = d.period       || '';
  document.getElementById('editArtist').value       = d.artistHint   || '';
  document.getElementById('editDesc').value         = d.description  || '';

  const conf = typeof d.confidence === 'number' ? d.confidence : 75;
  document.getElementById('editConfidence').value      = conf;
  document.getElementById('editConfidenceVal').textContent = conf + '%';

  document.getElementById('viewMode').style.display = 'none';
  document.getElementById('editMode').style.display = '';
  // Reset re-analyze status from any previous run
  const reanalyzeStatus = document.getElementById('reanalyzeStatus');
  if (reanalyzeStatus) { reanalyzeStatus.style.display = 'none'; reanalyzeStatus.textContent = ''; }
  const reanalyzeBtn = document.getElementById('reanalyzeBtn');
  if (reanalyzeBtn) { reanalyzeBtn.disabled = false; reanalyzeBtn.innerHTML = '🔄 Re-analyze with AI'; }
  document.getElementById('editLocation').focus();
}

function saveEdit() {
  const p = photos.find(x => x.id === activeModalId);
  if (!p) return;

  p.aiData.paintingName = document.getElementById('editPaintingName').value.trim() || p.aiData.paintingName;
  p.aiData.artist       = document.getElementById('editArtistName').value.trim()   || p.aiData.artist;
  p.aiData.location     = document.getElementById('editLocation').value.trim()     || p.aiData.location;
  p.aiData.country      = document.getElementById('editCountry').value.trim()      || p.aiData.country;
  p.aiData.style        = document.getElementById('editStyle').value.trim()        || p.aiData.style;
  p.aiData.medium       = document.getElementById('editMedium').value.trim()       || p.aiData.medium;
  p.aiData.period       = document.getElementById('editPeriod').value.trim()       || p.aiData.period;
  p.aiData.artistHint   = document.getElementById('editArtist').value.trim();
  p.aiData.description  = document.getElementById('editDesc').value.trim()         || p.aiData.description;
  p.aiData.confidence   = parseInt(document.getElementById('editConfidence').value, 10);
  p.aiData.manuallyEdited = true;

  // Return to view mode and refresh
  document.getElementById('viewMode').style.display = '';
  document.getElementById('editMode').style.display = 'none';
  refreshModalView(p);

  // Persist the edited metadata to the database
  updatePhotoDB(p);

  // Re-render cards so grouping updates to reflect new location/style
  render();
  // If map is visible, refresh it too (location may have changed)
  if (currentFilter === 'location') {
    selectedLocation = p.aiData.location;
    updateMap().then(() => {
      const entry = mapMarkers[p.aiData.location];
      if (entry) selectLocation(p.aiData.location, entry.marker, entry.infoWindow);
    });
  }
}

function cancelEdit() {
  document.getElementById('viewMode').style.display = '';
  document.getElementById('editMode').style.display = 'none';
}

function closeModal() {
  document.getElementById('modalBg').classList.remove('open');
  document.body.style.overflow = '';
  activeModalId = null;
}
function deleteFromModal() {
  const id = activeModalId;
  if (!id) return;
  closeModal();
  deletePhoto(id);
}
async function pinPhoto(id, shouldPin) {
  const photo = photos.find(p => p.id === id);
  if (!photo || !adminToken) return;

  // Snapshot ALL pinned states before touching anything — needed for full rollback
  const prevStates = new Map(photos.map(p => [p.id, !!p.pinned]));

  // Optimistic update: if pinning, unpin everything else in the same group first
  if (shouldPin) {
    const groupKey = p => `${p.aiData?.location}|${p.aiData?.style}|${p.aiData?.artist}`;
    const group    = groupKey(photo);
    photos.forEach(p => { if (groupKey(p) === group) p.pinned = false; });
  }
  photo.pinned = shouldPin;
  render();

  // Sync with server
  try {
    const res = await fetch(`${serverUrl}/api/photos/${id}/pin`, {
      method:  'PATCH',
      headers: authHeaders(),
      body:    JSON.stringify({ pinned: shouldPin })
    });
    // Treat any non-2xx as an error so the catch block can roll back
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `Server returned ${res.status}`);
    }
    const data = await res.json();
    photo.pinned = !!data.pinned;
    render();
  } catch (err) {
    console.warn('Pin sync failed:', err.message);
    // Full rollback — restore every photo to its pre-click pinned state
    photos.forEach(p => { p.pinned = prevStates.get(p.id) ?? false; });
    render();
  }
}

async function likePhoto(id, event) {
  if (event) event.stopPropagation();
  const photo   = photos.find(p => p.id === id);
  const isLiked = likedIds.has(id);

  // Optimistic update
  if (isLiked) {
    likedIds.delete(id);
    if (photo) photo.likes = Math.max((photo.likes || 1) - 1, 0);
  } else {
    likedIds.add(id);
    if (photo) photo.likes = (photo.likes || 0) + 1;
  }
  render();
  if (activeModalId === id) refreshModalLikeBtn(photo);

  // Sync with server
  try {
    const res  = await fetch(`${serverUrl}/api/photos/${id}/like`, {
      method: isLiked ? 'DELETE' : 'POST'
    });
    const data = await res.json();
    if (photo && data.likes !== undefined) {
      photo.likes = data.likes;
      render();
      if (activeModalId === id) refreshModalLikeBtn(photo);
    }
  } catch { /* optimistic update already applied */ }
}

function refreshModalLikeBtn(photo) {
  const btn = document.getElementById('modalLikeBtn');
  if (!btn || !photo) return;
  const liked = likedIds.has(photo.id);
  btn.className = 'modal-like-compact' + (liked ? ' liked' : '');
  btn.innerHTML = `${liked ? '♥' : '♡'} ${photo.likes || 0}`;
}


function bgClick(e) { if (e.target === document.getElementById('modalBg')) closeModal(); }

// ── Swipe-down on the drag handle / image area to close modal on mobile ──
(function() {
  let swipeStartY = 0, swipeStartEl = null;
  const modal = document.getElementById('modal');
  modal.addEventListener('touchstart', function(e) {
    // Only initiate swipe from image area or drag handle (not from scrollable body)
    const target = e.target.closest('.modal-img-wrap, #modalDragHandle');
    if (!target) return;
    swipeStartY = e.touches[0].clientY;
    swipeStartEl = target;
  }, { passive: true });
  modal.addEventListener('touchend', function(e) {
    if (!swipeStartEl) return;
    const dy = e.changedTouches[0].clientY - swipeStartY;
    if (dy > 60) closeModal();
    swipeStartEl = null;
  }, { passive: true });
})();

// Close mobile menu when tapping outside
document.addEventListener('click', e => {
  const menu = document.getElementById('headerMobileMenu');
  if (!menu) return;
  if (!e.target.closest('#headerMobileMenu') && !e.target.closest('.header-hamburger')) {
    menu.classList.remove('open');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Map
// ─────────────────────────────────────────────────────────────────────────────
let googleMap = null;
let mapMarkers = {};       // loc → { marker, coords, infoWindow }
let selectedLocation = null;
let _mapFitDone = false;
const geocodeCache = {};

// Coordinate lookup for 60+ known venues (no API call needed for these)
async function geocodeLocation(locationStr) {
  if (geocodeCache[locationStr]) return geocodeCache[locationStr];
  if (!serverUrl) return null;
  try {
    const res  = await fetch(`${serverUrl}/api/places?input=${encodeURIComponent(locationStr)}&sessiontoken=geocode`);
    const data = await res.json();
    const first = data.suggestions?.[0];
    if (first?.placePrediction?.placeId) {
      const det = await fetch(`${serverUrl}/api/place-details?place_id=${encodeURIComponent(first.placePrediction.placeId)}&sessiontoken=geocode`);
      const d   = await det.json();
      if (d.location) {
        const coords = [d.location.latitude, d.location.longitude];
        geocodeCache[locationStr] = coords;
        return coords;
      }
    }
  } catch (_) { /* ignore */ }
  return null;
}

// ── Google Maps bootstrap ─────────────────────────────────────────────────────
let mapsReady = false;
let mapsLoadPromise = null;

function loadGoogleMaps() {
  if (mapsReady) return Promise.resolve();
  if (mapsLoadPromise) return mapsLoadPromise;
  if (!serverUrl) return Promise.resolve();

  mapsLoadPromise = fetch(`${serverUrl}/api/config`)
    .then(r => r.json())
    .then(cfg => {
      if (!cfg.mapsApiKey) throw new Error('No Maps API key');
      return new Promise((resolve, reject) => {
        window._gmapsReady = () => { mapsReady = true; resolve(); };
        const s = document.createElement('script');
        s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(cfg.mapsApiKey)}&callback=_gmapsReady`;
        s.async = true;
        s.onerror = reject;
        document.head.appendChild(s);
      });
    })
    .catch(e => { console.warn('Google Maps failed to load:', e.message); mapsLoadPromise = null; });

  return mapsLoadPromise;
}

function initMap() {
  if (googleMap || !window.google?.maps) return;
  googleMap = new google.maps.Map(document.getElementById('map'), {
    center: { lat: 40.7831, lng: -73.9712 },
    zoom: 13,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
  });
  // Refresh sidebar list whenever the map is panned or zoomed
  googleMap.addListener('idle', updateLocationList);
}

async function updateMap() {
  await loadGoogleMaps();
  initMap();
  if (!googleMap) return;

  // Group completed photos by their AI-identified location
  const done = photos.filter(p => p.status === 'done' && p.aiData?.location);
  const groups = {};
  done.forEach(p => {
    const loc = p.aiData.location;
    if (!groups[loc]) groups[loc] = [];
    groups[loc].push(p);
  });

  // Remove markers for locations no longer present
  const currentLocations = new Set(Object.keys(groups));
  Object.keys(mapMarkers).forEach(loc => {
    if (!currentLocations.has(loc)) {
      mapMarkers[loc].marker.setMap(null);
      mapMarkers[loc].infoWindow?.close();
      delete mapMarkers[loc];
    }
  });

  const bounds = new google.maps.LatLngBounds();
  let hasCoords = false;

  for (const [loc, items] of Object.entries(groups)) {
    // Re-use cached coords if marker already exists for this location
    let coords = mapMarkers[loc]?.coords;
    if (!coords) {
      // Prefer exact GPS coords from any photo in this group
      const photoWithGPS = items.find(p => p.gpsCoords);
      coords = photoWithGPS
        ? photoWithGPS.gpsCoords
        : await geocodeLocation(loc);
    }
    if (!coords) continue;

    const latLng = { lat: coords[0], lng: coords[1] };
    bounds.extend(latLng);
    hasCoords = true;

    if (mapMarkers[loc]) {
      // Just refresh the photo count on the existing marker
      const pin = mapMarkers[loc].el;
      if (pin) pin.textContent = items.length;
      // Refresh infoWindow content
      mapMarkers[loc].infoWindow.setContent(
        `<div class="map-popup"><strong>${escHtml(loc)}</strong><span>${items.length} photo${items.length > 1 ? 's' : ''}</span></div>`
      );
    } else {
      const isSelected = selectedLocation === loc;

      // Build a custom styled marker using a circle + label
      const marker = new google.maps.Marker({
        position: latLng,
        map: googleMap,
        title: loc,
        label: { text: String(items.length), color: '#ffffff', fontWeight: '700', fontSize: '12px' },
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 18,
          fillColor:   isSelected ? '#8f0101' : '#e05c2e',
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 2,
        },
        zIndex: isSelected ? 10 : 1,
      });

      const infoWindow = new google.maps.InfoWindow({
        content: `<div class="map-popup"><strong>${escHtml(loc)}</strong><span>${items.length} photo${items.length > 1 ? 's' : ''}</span></div>`
      });

      marker.addListener('click', () => selectLocation(loc, marker, infoWindow));
      mapMarkers[loc] = { marker, coords, el: marker.label, infoWindow };
    }
  }

  // Clear selected location if it was deleted
  if (selectedLocation && !groups[selectedLocation]) {
    selectedLocation = null;
  }

  // Always refresh the sidebar list after markers are updated
  updateLocationList();

  // On first load, if all markers are far from the default Manhattan view, fit to them.
  if (hasCoords && !selectedLocation && !_mapFitDone) {
    _mapFitDone = true;
    const manhatLat = 40.7831, manhatLng = -73.9712;
    const anyNearManhattan = Object.values(mapMarkers).some(({ coords }) =>
      coords && Math.abs(coords[0] - manhatLat) < 5 && Math.abs(coords[1] - manhatLng) < 10
    );
    if (!anyNearManhattan) {
      if (Object.keys(groups).length === 1) {
        const only = Object.values(mapMarkers)[0];
        googleMap.setCenter({ lat: only.coords[0], lng: only.coords[1] });
        googleMap.setZoom(12);
      } else {
        googleMap.fitBounds(bounds, { top: 40, right: 40, bottom: 40, left: 40 });
      }
    }
  }
}

function selectLocation(loc, marker, infoWindow) {
  // Deselect all markers (reset to orange)
  Object.values(mapMarkers).forEach(({ marker: m, infoWindow: iw }) => {
    m.setIcon({ ...m.getIcon(), fillColor: '#e05c2e', scale: 18 });
    m.setZIndex(1);
    iw?.close();
  });

  selectedLocation = loc;

  // Highlight selected marker (dark red)
  marker.setIcon({ ...marker.getIcon(), fillColor: '#8f0101', scale: 21 });
  marker.setZIndex(10);
  infoWindow.open({ map: googleMap, anchor: marker });

  // Refresh sidebar list with updated active state
  updateLocationList();

  // Render gallery below the map
  const items = photos.filter(p => p.status === 'done' && p.aiData.location === loc);
  renderMapGallery(loc, items);

  const coords = mapMarkers[loc]?.coords;
  if (coords) {
    googleMap.panTo({ lat: coords[0], lng: coords[1] });
    if (googleMap.getZoom() < 12) googleMap.setZoom(12);
  }

  // Scroll gallery into view smoothly
  setTimeout(() => {
    document.getElementById('mapGallery')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 350);
}

function updateLocationList() {
  if (!googleMap) return;
  const bounds = googleMap.getBounds();
  const center = googleMap.getCenter();
  // Bounds can be null before tiles finish loading — retry once after a tick
  if (!bounds || !center) {
    setTimeout(updateLocationList, 200);
    return;
  }

  // Build groups from done photos
  const done = photos.filter(p => p.status === 'done' && p.aiData?.location);
  const groups = {};
  done.forEach(p => {
    const loc = p.aiData.location;
    if (!groups[loc]) groups[loc] = [];
    groups[loc].push(p);
  });

  // Keep only locations whose marker is within the current map bounds
  const visible = Object.entries(groups).filter(([loc]) => {
    const coords = mapMarkers[loc]?.coords;
    return coords && bounds.contains({ lat: coords[0], lng: coords[1] });
  });

  // Sort by distance from map center (Euclidean — fine for city-scale)
  const clat = center.lat(), clng = center.lng();
  visible.sort(([locA], [locB]) => {
    const cA = mapMarkers[locA].coords;
    const cB = mapMarkers[locB].coords;
    const dA = (cA[0] - clat) ** 2 + (cA[1] - clng) ** 2;
    const dB = (cB[0] - clat) ** 2 + (cB[1] - clng) ** 2;
    return dA - dB;
  });

  renderSidebarList(visible.slice(0, 5));
}

function renderSidebarList(entries) {
  const list = document.getElementById('sidebarList');
  if (!list) return;

  if (!entries.length) {
    list.innerHTML = '<div class="sidebar-empty-msg">No locations visible<br>in current map view.<br>Try zooming out.</div>';
    return;
  }

  list.innerHTML = entries.map(([loc, items]) => {
    const isActive = selectedLocation === loc;
    const country = items[0]?.aiData?.country || '';
    const meta = `${country}${country ? ' · ' : ''}${items.length} photo${items.length > 1 ? 's' : ''}`;
    const thumbsHtml = items.slice(0, 3).map(p =>
      `<img class="sidebar-loc-thumb" src="${p.url}" alt="${escHtml(p.aiData?.paintingName || p.name)}" loading="lazy" />`
    ).join('');
    const moreHtml = items.length > 3
      ? `<div class="sidebar-loc-thumb sidebar-loc-more">+${items.length - 3}</div>` : '';

    return `
      <div class="sidebar-loc-row${isActive ? ' active' : ''}" onclick="selectLocationByName(${escHtml(JSON.stringify(loc))})">
        <div class="sidebar-loc-name">${escHtml(loc)}</div>
        <div class="sidebar-loc-meta">${escHtml(meta)}</div>
        <div class="sidebar-loc-thumbs">${thumbsHtml}${moreHtml}</div>
      </div>`;
  }).join('');
}

function selectLocationByName(loc) {
  const entry = mapMarkers[loc];
  if (!entry) return;
  selectLocation(loc, entry.marker, entry.infoWindow);
}

function renderMapGallery(loc, items) {
  const gallery = document.getElementById('mapGallery');
  if (!gallery) return;

  if (!loc || !items.length) {
    gallery.style.display = 'none';
    return;
  }

  const country = items[0]?.aiData?.country || '';
  const sub = `${country}${country ? ' · ' : ''}${items.length} photo${items.length > 1 ? 's' : ''}`;

  // Pinned first, then by likes descending
  const sorted = [...items].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return (b.likes || 0) - (a.likes || 0);
  });

  gallery.innerHTML = `
    <div class="location-group" style="margin-bottom:0">
      <div class="location-header">
        <span class="location-icon">📍</span>
        <span class="location-name">${escHtml(loc)}</span>
        <span class="location-sub">${escHtml(sub)}</span>
      </div>
      <div class="photo-grid">
        ${sorted.map((p, i) => photoCard(p, i === 0 && sorted.length >= 3)).join('')}
      </div>
    </div>`;
  gallery.style.display = '';
}

window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  if (adminToken) handleFiles(e.dataTransfer.files);
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Proxy server URL — update this if you redeploy to a new Railway URL
serverUrl = 'https://art-pokedex-production.up.railway.app';

// Sync currentFilter from whichever filter button has the 'active' class in the HTML.
// This makes the HTML the single source of truth so the two never get out of sync
// (e.g. if the browser has a cached version of this script).
(function syncFilterFromDOM() {
  const activeBtn = document.querySelector('.filter-btn.active');
  if (activeBtn) {
    const m = activeBtn.getAttribute('onclick')?.match(/setFilter\('(\w+)'/);
    if (m && m[1]) currentFilter = m[1];
  }
  // Ensure the grouping toggle is hidden for any non-'all' filter
  const toggle = document.getElementById('groupingToggle');
  if (toggle) toggle.style.display = currentFilter === 'all' ? '' : 'none';
})();

// Load any previously saved photos from the database
loadSavedPhotos();
