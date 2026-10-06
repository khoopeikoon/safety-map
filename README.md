# SafeWalk

A mobile-friendly map for walking directions. Plain static site, no build step, no API keys.

- Map tiles: OpenStreetMap
- Place search: Nominatim (press Enter to search)
- Walking routes: OSRM foot profile at routing.openstreetmap.de
- Population: Modified ZIP Code Tabulation Areas with population estimates from NYC Open Data, dataset `pri4-ifjk`
- Crime data: NYPD Complaint Data Current (Year To Date) from NYC Open Data, dataset `5uac-w243`

## Use

Tap the map once for your start and again for your destination, or search for places. Pins can be dragged. The ◎ button uses your location as the start. Grey dotted lines are alternative routes; tap one to switch. "Open in Apple Maps" hands the walk to Apple Maps for turn-by-turn navigation.

## Police reports (New York City)

Zoom in anywhere in NYC to see NYPD crime reports from the 90 days before the dataset's newest report, colored by severity (felony, misdemeanor, violation). Tap a dot for the offense, date and time. Dots fade as reports get older, and shrink where more people live: size is scaled by the residential density of the dot's ZIP code (log scale between the city's 5th and 95th percentile), so a report in a sparse area stands out more than one on a crowded block. By default only reports in public places (streets, subway, parks, bus stops and similar) are shown; tick "Include indoor reports" to see all of them. The city updates this dataset quarterly, so the newest reports are usually a few months old.

## Run locally

```
python3 -m http.server 8000
```

Then open http://localhost:8000. Location needs https or localhost.
