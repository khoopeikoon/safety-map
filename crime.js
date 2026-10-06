// NYPD crime reports overlay, from NYC Open Data (no API key needed).
// Dataset: "NYPD Complaint Data Current (Year To Date)", id 5uac-w243.
// The city publishes it quarterly, so the newest reports are usually a few months old.
// Reports load for the visible area once the map is zoomed in far enough.
function initCrimeLayer(map) {
  'use strict';

  const API = 'https://data.cityofnewyork.us/resource/5uac-w243.json';
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

  function setNote(msg) { ui.note.textContent = msg; }

  async function refresh() {
    layer.clearLayers();
    if (!ui.toggle.checked) return setNote('');
    if (!map.getBounds().intersects(NYC)) return setNote('Police reports are available in New York City only.');
    if (map.getZoom() < MIN_ZOOM) return setNote('Zoom in to see police reports.');

    const id = ++request;
    setNote('Loading police reports…');
    try {
      if (!since) await loadRange();
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
          renderer, radius: r.law_cat_cd === 'FELONY' ? 6 : 5,
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
    for (const line of [title(r.pd_desc), `${title(r.law_cat_cd)} · ${title(r.prem_typ_desc)}`, when]) {
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
