// NYPD crime reports overlay, from NYC Open Data (no API key needed).
// Dataset: "NYPD Complaint Data Current (Year To Date)", id 5uac-w243.
// The city publishes it quarterly, so the newest reports are usually a few months old.
// Reports load for the visible area once the map is zoomed in far enough.
function initCrimeLayer(map) {
  'use strict';

  const API = 'https://data.cityofnewyork.us/resource/5uac-w243.json';
  // Modified ZIP Code Tabulation Areas: boundaries plus resident population estimates.
  const ZIPS_API = 'https://data.cityofnewyork.us/resource/pri4-ifjk.json';
  // Dot size by residential density: sparse areas get big dots, dense areas small ones,
  // so a report where few people live stands out more than one in a crowded block.
  const RADIUS_SPARSE = 9, RADIUS_DENSE = 3.5, RADIUS_UNKNOWN = 6;
  const WINDOW_DAYS = 90;
  const MIN_ZOOM = 15;
  const LIMIT = 3000;
  // Places someone on foot passes through. Indoor reports (homes, shops) are hidden by default.
  const PUBLIC_PLACES = [
    'STREET', 'TRANSIT - NYC SUBWAY', 'PARK/PLAYGROUND', 'TRANSIT FACILITY (OTHER)', 'BUS STOP',
    'BRIDGE', 'OPEN AREAS (OPEN LOTS)', 'PARKING LOT/GARAGE (PUBLIC)', 'HIGHWAY/PARKWAY', 'BUS TERMINAL',
  ];
  const COLORS = { FELONY: '#d64545', MISDEMEANOR: '#e8902a', VIOLATION: '#c9b02b' };
  // Rough NYC bounds, used to tell the user to look in New York.
  const NYC = L.latLngBounds([40.49, -74.27], [40.92, -73.68]);

  const $ = (id) => document.getElementById(id);
  const ui = { toggle: $('crime-toggle'), indoor: $('crime-indoor'), note: $('crime-note') };
  // Own pane below the route lines (overlayPane is 400) so routes stay readable.
  map.createPane('crime').style.zIndex = 350;
  const renderer = L.canvas({ padding: 0.5, pane: 'crime' });
  const layer = L.layerGroup().addTo(map);

  let since = null;        // ISO date string for the start of the window
  let latestMs = 0;        // newest report in the dataset, for fading older dots
  let zips = null;         // [{ zip, density, bbox, polys }], density in people per sq mi
  let densityLo = 0, densityHi = 0;   // citywide 5th and 95th percentile densities
  let rangeLabel = '';
  let request = 0;
  let timer = null;

  const fmtDate = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const q = (s) => `'${s.replace(/'/g, "''")}'`;
  const title = (s) => (s || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

  async function getJSON(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // Find the newest report date once, then show the WINDOW_DAYS before it.
  async function loadRange() {
    const [row] = await getJSON(`${API}?$select=max(rpt_dt) as latest`);
    const latest = new Date(row.latest);
    const start = new Date(latest.getTime() - WINDOW_DAYS * 864e5);
    since = start.toISOString().slice(0, 19);
    latestMs = latest.getTime();
    rangeLabel = `${fmtDate(start)} to ${fmtDate(latest)}`;
  }

  // Load every NYC ZIP area once (simplified outlines keep this small) and work out
  // residents per square mile for each.
  async function loadZips() {
    const rows = await getJSON(`${ZIPS_API}?$select=modzcta,pop_est,simplify_preserve_topology(the_geom,0.0001) as geom&$limit=500`);
    zips = [];
    for (const r of rows) {
      const pop = parseFloat(r.pop_est);
      if (!r.geom || !(pop > 0)) continue;
      const polys = r.geom.type === 'Polygon' ? [r.geom.coordinates] : r.geom.coordinates;
      const sqmi = polys.reduce((sum, rings) => sum + rings.reduce((a, ring, i) => a + (i ? -1 : 1) * ringAreaSqMi(ring), 0), 0);
      if (!(sqmi > 0)) continue;
      let w = 180, s = 90, e = -180, n = -90;
      for (const rings of polys) for (const [x, y] of rings[0]) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
      zips.push({ zip: r.modzcta, density: pop / sqmi, bbox: [w, s, e, n], polys });
    }
    const sorted = zips.map((z) => z.density).sort((a, b) => a - b);
    densityLo = sorted[Math.floor(sorted.length * 0.05)];
    densityHi = sorted[Math.floor(sorted.length * 0.95)];
  }

  // Ring area on a flat projection around NYC; plenty accurate at city scale.
  function ringAreaSqMi(ring) {
    const lat0 = 40.7 * Math.PI / 180;
    const kx = 69.17 * Math.cos(lat0), ky = 69.05; // miles per degree
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      a += (ring[j][0] * kx) * (ring[i][1] * ky) - (ring[i][0] * kx) * (ring[j][1] * ky);
    }
    return Math.abs(a / 2);
  }

  function inRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function zipAt(lat, lng) {
    if (!zips) return null;
    for (const z of zips) {
      const [w, s, e, n] = z.bbox;
      if (lng < w || lng > e || lat < s || lat > n) continue;
      // Even-odd across all rings handles holes.
      for (const rings of z.polys) {
        let inside = false;
        for (const ring of rings) if (inRing(lng, lat, ring)) inside = !inside;
        if (inside) return z;
      }
    }
    return null;
  }

  function densityAt(lat, lng) {
    const z = zipAt(lat, lng);
    return z ? z.density : null;
  }

  function radiusFor(density) {
    if (density == null || !(densityHi > densityLo)) return RADIUS_UNKNOWN;
    const lo = Math.log(densityLo), hi = Math.log(densityHi);
    const t = Math.min(1, Math.max(0, (Math.log(density) - lo) / (hi - lo)));
    return RADIUS_SPARSE - (RADIUS_SPARSE - RADIUS_DENSE) * t;
  }

  function setNote(msg) { ui.note.textContent = msg; }

  async function refresh() {
    layer.clearLayers();
    if (!ui.toggle.checked) return setNote('');
    if (!map.getBounds().intersects(NYC)) return setNote('Police reports are available in New York City only.');
    if (map.getZoom() < MIN_ZOOM) return setNote('Zoom in to see police reports.');

    const id = ++request;
    setNote('Loading police reports…');
    try {
      if (!since) await Promise.all([loadRange(), loadZips().catch(() => {})]); // dots fall back to one size without ZIP data
      const b = map.getBounds();
      const where = [
        `rpt_dt >= '${since}'`,
        `latitude between ${b.getSouth()} and ${b.getNorth()}`,
        `longitude between ${b.getWest()} and ${b.getEast()}`,
      ];
      if (!ui.indoor.checked) where.push(`prem_typ_desc in(${PUBLIC_PLACES.map(q).join(',')})`);
      const url = `${API}?$select=cmplnt_fr_dt,cmplnt_fr_tm,ofns_desc,pd_desc,law_cat_cd,prem_typ_desc,latitude,longitude` +
        `&$where=${encodeURIComponent(where.join(' AND '))}&$order=rpt_dt DESC&$limit=${LIMIT}`;
      const rows = await getJSON(url);
      if (id !== request) return;
      for (const r of rows) {
        const lat = parseFloat(r.latitude), lng = parseFloat(r.longitude);
        if (!lat || !lng) continue;
        const color = COLORS[r.law_cat_cd] || '#8a8a92';
        L.circleMarker([lat, lng], {
          renderer, radius: radiusFor(densityAt(lat, lng)),
          color: '#fff', weight: 1, opacity: ageOpacity(r), fillColor: color, fillOpacity: ageOpacity(r),
          pane: 'crime', bubblingMouseEvents: false, // tapping a dot should not drop a route pin
        }).bindPopup(popup(r)).addTo(layer);
      }
      const more = rows.length >= LIMIT ? ` (newest ${LIMIT} shown)` : '';
      setNote(`${rows.length} police report${rows.length === 1 ? "" : "s"} here, ${rangeLabel}${more}.`);
    } catch (_) {
      if (id === request) setNote('Could not load police reports. Try again in a moment.');
    }
  }

  // Newest reports are solid; ones at the start of the window fade to 0.2.
  function ageOpacity(r) {
    const t = Date.parse(r.cmplnt_fr_dt);
    if (!t) return 0.2;
    const age = Math.min(1, Math.max(0, (latestMs - t) / (WINDOW_DAYS * 864e5)));
    return 0.9 - 0.7 * age;
  }

  function popup(r) {
    const div = document.createElement('div');
    const when = r.cmplnt_fr_dt ? fmtDate(new Date(r.cmplnt_fr_dt)) + (r.cmplnt_fr_tm ? `, ${r.cmplnt_fr_tm.slice(0, 5)}` : '') : 'Date unknown';
    const strong = document.createElement('strong');
    strong.textContent = title(r.ofns_desc) || 'Report';
    div.appendChild(strong);
    const z = zipAt(parseFloat(r.latitude), parseFloat(r.longitude));
    const density = z ? `ZIP ${z.zip}: ${(Math.round(z.density / 100) * 100).toLocaleString()} residents per sq mi` : '';
    for (const line of [title(r.pd_desc), `${title(r.law_cat_cd)} · ${title(r.prem_typ_desc)}`, when, density]) {
      if (!line) continue;
      div.appendChild(document.createElement('br'));
      div.appendChild(document.createTextNode(line));
    }
    return div;
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(refresh, 400);
  }

  map.on('moveend', schedule);
  ui.toggle.addEventListener('change', refresh);
  ui.indoor.addEventListener('change', refresh);
  refresh();

  return { nycBounds: NYC };
}
