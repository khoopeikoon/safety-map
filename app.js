// SafeWalk: walking directions on OpenStreetMap.
// Free services, no API keys:
//   tiles     tile.openstreetmap.org
//   search    nominatim.openstreetmap.org (searches on Enter only, per its usage policy)
//   routing   routing.openstreetmap.de (OSRM with the foot profile)
(function () {
  'use strict';

  const NOMINATIM = 'https://nominatim.openstreetmap.org';
  const OSRM_FOOT = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot';

  const $ = (id) => document.getElementById(id);
  const ui = {
    from: $('from'), to: $('to'),
    fromResults: $('from-results'), toResults: $('to-results'),
    locate: $('locate'), swap: $('swap'), clear: $('clear'),
    status: $('status'), summary: $('summary'),
    sumTime: $('sum-time'), sumDist: $('sum-dist'),
    toggleSteps: $('toggle-steps'), steps: $('steps'), appleMaps: $('apple-maps'),
  };

  const map = L.map('map', { zoomControl: false }).setView([51.505, -0.09], 14);
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const pinIcon = (cls) => L.divIcon({ className: '', html: `<div class="pin ${cls}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });

  // Two endpoints, each { latlng, label, marker }.
  const points = { from: null, to: null };
  let routeLayers = [];
  let routes = [];
  let selected = 0;
  let meMarker = null;
  let routeRequest = 0;

  // ---------- helpers ----------
  function setStatus(msg, isError) {
    ui.status.textContent = msg || '';
    ui.status.classList.toggle('error', !!isError);
  }

  function fmtDist(m) {
    return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
  }

  function fmtTime(s) {
    const min = Math.max(1, Math.round(s / 60));
    if (min < 60) return `${min} min`;
    return `${Math.floor(min / 60)} h ${min % 60} min`;
  }

  function shortName(place) {
    if (!place) return '';
    const a = place.address || {};
    const first = place.name || [a.house_number, a.road].filter(Boolean).join(' ') || a.road;
    const area = a.suburb || a.neighbourhood || a.city || a.town || a.village;
    const parts = [first, area].filter(Boolean);
    return parts.length ? parts.join(', ') : (place.display_name || '').split(',').slice(0, 2).join(',');
  }

  async function getJSON(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // ---------- endpoints ----------
  function setPoint(which, latlng, label) {
    const cur = points[which];
    if (cur) map.removeLayer(cur.marker);
    const marker = L.marker(latlng, { icon: pinIcon(which === 'from' ? 'pin-start' : 'pin-end'), draggable: true }).addTo(map);
    marker.on('dragend', () => {
      const ll = marker.getLatLng();
      points[which].latlng = ll;
      labelFromMap(which, ll);
      updateRoute();
    });
    points[which] = { latlng: L.latLng(latlng), label: label || '', marker };
    ui[which].value = label || 'Dropped pin';
    if (!label) labelFromMap(which, latlng);
    updateRoute();
  }

  async function labelFromMap(which, latlng) {
    const p = points[which];
    if (!p) return;
    ui[which].value = 'Dropped pin';
    try {
      const place = await getJSON(`${NOMINATIM}/reverse?format=jsonv2&addressdetails=1&zoom=18&lat=${latlng.lat}&lon=${latlng.lng}`);
      // Ignore if the pin moved again while we were waiting.
      if (points[which] === p && p.latlng.equals(latlng)) {
        p.label = shortName(place) || 'Dropped pin';
        ui[which].value = p.label;
      }
    } catch (_) { /* keep "Dropped pin" */ }
  }

  function clearAll() {
    for (const k of ['from', 'to']) {
      if (points[k]) map.removeLayer(points[k].marker);
      points[k] = null;
      ui[k].value = '';
    }
    clearRoute();
    hideResults();
    setStatus('');
  }

  map.on('click', (e) => {
    hideResults();
    if (!points.from) setPoint('from', e.latlng);
    else setPoint('to', e.latlng);
  });

  ui.swap.addEventListener('click', () => {
    const f = points.from, t = points.to;
    if (f) map.removeLayer(f.marker);
    if (t) map.removeLayer(t.marker);
    points.from = points.to = null;
    ui.from.value = ui.to.value = '';
    if (t) setPoint('from', t.latlng, t.label || 'Dropped pin');
    if (f) setPoint('to', f.latlng, f.label || 'Dropped pin');
  });

  ui.clear.addEventListener('click', clearAll);

  ui.locate.addEventListener('click', () => {
    if (!navigator.geolocation) return setStatus('Location is not available in this browser.', true);
    setStatus('Finding you…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const ll = L.latLng(pos.coords.latitude, pos.coords.longitude);
        setStatus('');
        showMe(ll);
        setPoint('from', ll, 'My location');
        if (!points.to) map.setView(ll, 16);
      },
      () => setStatus('Could not get your location. Check location permission for this site.', true),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  function showMe(ll) {
    if (meMarker) meMarker.setLatLng(ll);
    else meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }), interactive: false }).addTo(map);
  }

  // ---------- search ----------
  function hideResults() {
    ui.fromResults.hidden = ui.toResults.hidden = true;
  }

  async function search(which) {
    const q = ui[which].value.trim();
    const list = ui[which + 'Results'];
    if (!q) return;
    setStatus('Searching…');
    const b = map.getBounds().pad(2);
    const url = `${NOMINATIM}/search?format=jsonv2&addressdetails=1&limit=5&q=${encodeURIComponent(q)}` +
      `&viewbox=${b.getWest()},${b.getNorth()},${b.getEast()},${b.getSouth()}`;
    try {
      const results = await getJSON(url);
      setStatus(results.length ? '' : 'No places found. Try adding the area or city.');
      list.innerHTML = '';
      for (const r of results) {
        const li = document.createElement('li');
        li.tabIndex = 0;
        li.textContent = r.display_name;
        const pick = () => {
          hideResults();
          setPoint(which, [parseFloat(r.lat), parseFloat(r.lon)], shortName(r));
          if (!points.from || !points.to) map.setView([r.lat, r.lon], 16);
        };
        li.addEventListener('click', pick);
        li.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(); });
        list.appendChild(li);
      }
      list.hidden = !results.length;
    } catch (_) {
      setStatus('Search failed. Check your connection and try again.', true);
    }
  }

  for (const which of ['from', 'to']) {
    ui[which].addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); search(which); }
    });
  }
  $('route-form').addEventListener('submit', (e) => e.preventDefault());

  // ---------- routing ----------
  function clearRoute() {
    routeLayers.forEach((l) => map.removeLayer(l));
    routeLayers = [];
    routes = [];
    ui.summary.hidden = true;
    ui.appleMaps.hidden = true;
    ui.steps.hidden = true;
    ui.steps.innerHTML = '';
  }

  async function updateRoute() {
    if (!points.from || !points.to) return;
    const id = ++routeRequest;
    const a = points.from.latlng, b = points.to.latlng;
    setStatus('Finding a walking route…');
    try {
      const data = await getJSON(`${OSRM_FOOT}/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson&steps=true&alternatives=true`);
      if (id !== routeRequest) return;
      if (data.code !== 'Ok' || !data.routes.length) throw new Error(data.code);
      clearRoute();
      routes = data.routes;
      selected = 0;
      drawRoutes(true);
      setStatus(routes.length > 1 ? 'Tap a grey line to pick another route.' : '');
    } catch (_) {
      if (id !== routeRequest) return;
      clearRoute();
      setStatus('Could not find a walking route between these points.', true);
    }
  }

  function drawRoutes(fit) {
    routeLayers.forEach((l) => map.removeLayer(l));
    routeLayers = [];
    // Draw alternatives first so the selected route sits on top.
    const order = routes.map((_, i) => i).filter((i) => i !== selected).concat(selected);
    for (const i of order) {
      const coords = routes[i].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
      const isSel = i === selected;
      if (isSel) routeLayers.push(L.polyline(coords, { color: '#ffffff', weight: 9, opacity: 0.9, interactive: false }).addTo(map));
      const line = L.polyline(coords, {
        color: isSel ? '#1f6f5c' : '#8a8a92', weight: isSel ? 6 : 5, opacity: isSel ? 1 : 0.7,
        dashArray: isSel ? null : '1 8', lineCap: 'round',
      }).addTo(map);
      if (!isSel) line.on('click', (e) => { L.DomEvent.stop(e); selected = i; drawRoutes(false); });
      routeLayers.push(line);
    }
    const r = routes[selected];
    ui.sumTime.textContent = fmtTime(r.duration);
    ui.sumDist.textContent = fmtDist(r.distance);
    ui.summary.hidden = false;
    ui.appleMaps.href = appleMapsUrl(points.from.latlng, points.to.latlng);
    ui.appleMaps.hidden = false;
    renderSteps(r);
    if (fit) map.fitBounds(L.latLngBounds(r.geometry.coordinates.map(([lng, lat]) => [lat, lng])), { padding: [40, 40], paddingBottomRight: [0, window.innerWidth < 720 ? window.innerHeight * 0.35 : 0] });
  }

  // Hands the trip to Apple Maps for turn-by-turn walking navigation.
  // On iPhone this opens the Maps app; elsewhere it opens maps.apple.com.
  function appleMapsUrl(a, b) {
    const ll = (p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
    return `https://maps.apple.com/?saddr=${ll(a)}&daddr=${ll(b)}&dirflg=w`;
  }

  function describe(step) {
    const m = step.maneuver;
    const road = step.name ? ` onto ${step.name}` : '';
    const mod = m.modifier ? m.modifier.replace('sharp ', 'sharp ').replace('slight ', 'slightly ') : '';
    switch (m.type) {
      case 'depart': return `Head ${compass(m.bearing_after)}${step.name ? ` on ${step.name}` : ''}`;
      case 'arrive': return 'Arrive at your destination';
      case 'turn': case 'end of road': case 'fork':
        return mod === 'straight' ? `Continue straight${road}` : `Turn ${mod}${road}`;
      case 'roundabout': case 'rotary': return `At the roundabout, take exit ${m.exit || ''}${road}`.replace('  ', ' ');
      case 'new name': case 'continue': return `Continue${step.name ? ` on ${step.name}` : ''}`;
      default: return mod ? `Go ${mod}${road}` : `Continue${road}`;
    }
  }

  function compass(deg) {
    return ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'][Math.round(deg / 45) % 8];
  }

  function renderSteps(route) {
    ui.steps.innerHTML = '';
    for (const leg of route.legs) {
      for (const step of leg.steps) {
        const li = document.createElement('li');
        li.textContent = describe(step);
        if (step.distance > 0) {
          const s = document.createElement('small');
          s.textContent = fmtDist(step.distance);
          li.appendChild(s);
        }
        li.addEventListener('click', () => {
          const [lng, lat] = step.maneuver.location;
          map.setView([lat, lng], 18);
        });
        ui.steps.appendChild(li);
      }
    }
    ui.toggleSteps.textContent = ui.steps.hidden ? 'Show steps' : 'Hide steps';
  }

  ui.toggleSteps.addEventListener('click', () => {
    ui.steps.hidden = !ui.steps.hidden;
    ui.toggleSteps.textContent = ui.steps.hidden ? 'Show steps' : 'Hide steps';
  });

  // Start near the user if they allow it, without asking for a route.
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition((pos) => {
      const ll = L.latLng(pos.coords.latitude, pos.coords.longitude);
      showMe(ll);
      if (!points.from && !points.to) map.setView(ll, 15);
    }, () => {}, { timeout: 8000 });
  }
})();
