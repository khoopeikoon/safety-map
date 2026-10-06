# SafeWalk

A mobile-friendly map for walking directions. Plain static site, no build step, no API keys.

- Map tiles: OpenStreetMap
- Place search: Nominatim (press Enter to search)
- Walking routes: OSRM foot profile at routing.openstreetmap.de

## Use

Tap the map once for your start and again for your destination, or search for places. Pins can be dragged. The ◎ button uses your location as the start. Grey dotted lines are alternative routes; tap one to switch. "Open in Apple Maps" hands the walk to Apple Maps for turn-by-turn navigation.

## Run locally

```
python3 -m http.server 8000
```

Then open http://localhost:8000. Location needs https or localhost.
