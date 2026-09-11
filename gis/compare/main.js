// Track B: the light, site-scoped viewer.
//
// Track A (index.html) draws the whole 9-sheet AOI and swaps OSM for NGII
// inside it; this page draws ONLY the Seun zones and their 1,759 buildings
// from the committed extraction - no database, no bbox API, no swap
// machinery. What Track A treats as toggles (colour by use) or sliders
// (storey height) are facts here: a building's colour IS its use, and its
// storey height comes from what kind of building it is (USE_STOREY_M).

import {
  COLORS,
  BASEMAP_SURROUND_PADDING_M,
  LOD_STEPS,
  MIN_DEMOLITION_AREA_M2,
  OSM_BUILDING_LAYERS,
  USE_STOREY_M,
} from "./config.js";
import {
  postComparisonBuilding,
  postComparisonScenario,
  startComparisonBridge,
} from "./comparison.js";
import { addComparisonCurtain, LEFT_CLIP } from "./curtain.js";
import { createMap, scheduleTerrain, waitIdle } from "./map.js";
import { estimateKosmBuildingScale } from "./kosm-style.js";
import { intersectsArea } from "./swap.js";
import { Zones, ZONES_SOURCE } from "./zones.js";
import { generateMassing, verifyInsideZone } from "./zoneupdate.js";
import { createGeoJSONUpdater } from "./geojson-updates.js";

const $ = (id) => document.getElementById(id);
const pathParts = location.pathname.split("/");
const IS_COMPARISON = pathParts.includes("compare");
const SNAPSHOT = IS_COMPARISON
  ? "compare"
  : pathParts.includes("after")
    ? "after"
    : "before";
const status = (text) => {
  $("status").textContent = text;
};

export const SITE_SOURCE = "site-buildings";
export const SITE_LAYER = "site-3d";
export const AFTER_SITE_SOURCE = "site-buildings-after";
export const AFTER_SITE_LAYER = "site-3d-after";
export const SELECTED_LAYER = "site-selected";
export const AFTER_SELECTED_LAYER = "site-selected-after";
export const SIM_ZONE_FILL_LAYER = "sim-zones-fill";
export const SIM_ZONE_GLOW_LAYERS = [
  "sim-zones-glow-3",
  "sim-zones-glow-2",
  "sim-zones-glow-1",
];
export const SIM_ZONE_LINE_LAYER = "sim-zones-outline";
const SIM_ZONE_LAYERS = [
  SIM_ZONE_FILL_LAYER,
  ...SIM_ZONE_GLOW_LAYERS,
  SIM_ZONE_LINE_LAYER,
];
const SIM_ZONE_COLOR = "#e11d2e";
const SIM_ZONE_GLOW_COLOR = "#ff4d5a";
const SELECT_COLOR = "#ffd24a";

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

// Start every independent network request together. MapLibre still needs its
// style before layers can be added, but local data does not need to wait for
// the remote style request to finish.
const mapReady = createMap("map");
const siteDataReady = fetchJson(
  new URL("../data/site_buildings.geojson", import.meta.url),
);
const zoneDataReady = fetchJson(
  new URL("../data/zones.geojson", import.meta.url),
);
const preparedModels = fetchJson(new URL("./scenario-models.json", import.meta.url), { cache: "no-store" });
const scenarioDataReady = {
  current: preparedModels.then((models) => models.current),
  previous: preparedModels.then((models) => models.previous),
};

const map = await mapReady;
const zones = new Zones(map);

const firstSymbol = map
  .getStyle()
  .layers.find((l) => l.type === "symbol")?.id;

/**
 * Draw every basemap symbol before our extrusions so building faces hide
 * road names, place labels, shields, and POIs behind them.
 */
function moveBasemapSymbolsBelow(anchorId) {
  if (!anchorId || !map.getLayer(anchorId)) return;
  const symbols = map
    .getStyle()
    .layers.filter((layer) => layer.type === "symbol");
  for (const layer of symbols) map.moveLayer(layer.id, anchorId);
}

export const OSM_OUTSIDE_LAYER = "osm-outside-zones";
export const OSM_STRADDLE_LAYER = "osm-straddle-zones";
const OSM_STRADDLE_SOURCE = "osm-straddle-zones-src";
const KOSM_SELECTED_LAYER = "kosm-selected-building";

/** OSM ids hidden because they touch a zone; see addOsmOutsideZones. */
let maskedIds = new Set();

/** Cost of the last mask scan, in ms - this was 3.6 s before the bbox
 * pre-filter, on every `idle`, which is what made startup crawl. */
let lastScanMs = 0;

/**
 * The mirofish scenario: fid -> {features, report, config}.
 *
 * Track A keeps this separate from a second Map of hand-made edits, since
 * there the two must be switchable independently. Track B has no editing,
 * so one Map is the whole story.
 */
const simZones = new Map();

/** Whether the scenario is DRAWN. Hiding never discards it. */
let simVisible = SNAPSHOT !== "before";
$("sim-toggle").checked = simVisible;

/** The scenario file's own metadata, for the panel header. */
let simMeta = { scenario: null, status: null };
let scenarioConfig = null;
let scenarioModel = "current";
let scenarioRequest = 0;

/** Currently inspected building, or null for the per-zone summary. */
let selectedBuilding = null;
let selectedId = null;
let selectedKosmId = null;

function syncSelectionHighlight() {
  const filter = [
    "==",
    ["to-string", ["get", "sel_id"]],
    String(selectedId ?? -1),
  ];
  for (const id of [SELECTED_LAYER, AFTER_SELECTED_LAYER]) {
    if (map.getLayer(id)) map.setFilter(id, filter);
  }
  if (map.getLayer(KOSM_SELECTED_LAYER)) {
    map.setFilter(KOSM_SELECTED_LAYER, [
      "in",
      ["id"],
      ["literal", selectedKosmId == null ? [] : [selectedKosmId]],
    ]);
  }
}

function refreshSimZoneMark() {
  const fids = [...simZones.keys()];
  const filter = ["in", ["get", "fid"], ["literal", fids.length ? fids : [-1]]];
  for (const id of SIM_ZONE_LAYERS) {
    if (!map.getLayer(id)) continue;
    map.setFilter(id, filter);
    map.setLayoutProperty(id, "visibility", simVisible ? "visible" : "none");
  }
}

/**
 * The swap, zone-scoped: OSM buildings everywhere EXCEPT inside a zone,
 * ours inside. Same shape as Track A's sheet-grid swap (swap.js), with
 * the zones' union as the boundary instead of the 9-sheet AREA.
 *
 * `within` excludes only features FULLY inside the union, so an OSM
 * building straddling a zone edge is still drawn and can overlap ours -
 * the same edge behaviour Track A accepts, without Track A's id-masking
 * machinery. Zone-scoped the boundary is ~50x shorter than the sheet
 * grid's, so the overlap population is smaller still.
 */
function addOsmOutsideZones(zoneUnion) {
  const template = map.getLayer("building-3d");
  if (!template) {
    console.warn("style has no building-3d layer; surround unavailable");
    return false;
  }
  const heightExpression = map.getPaintProperty(
    "building-3d",
    "fill-extrusion-height",
  );
  const baseExpression = map.getPaintProperty(
    "building-3d",
    "fill-extrusion-base",
  );
  for (const id of OSM_BUILDING_LAYERS) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
  }

  const zoneBoxes = zoneUnion.coordinates.map((poly) => {
    let minX = 180;
    let minY = 90;
    let maxX = -180;
    let maxY = -90;
    for (const [x, y] of poly[0]) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
  });
  const siteBox = zoneBoxes.reduce((a, b) => ({
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  }));
  const centerLat = (siteBox.minY + siteBox.maxY) / 2;
  const lonPadding =
    BASEMAP_SURROUND_PADDING_M /
    (111320 * Math.cos((centerLat * Math.PI) / 180));
  const latPadding = BASEMAP_SURROUND_PADDING_M / 110540;
  const surroundBox = {
    minX: siteBox.minX - lonPadding,
    minY: siteBox.minY - latPadding,
    maxX: siteBox.maxX + lonPadding,
    maxY: siteBox.maxY + latPadding,
  };

  map.addLayer(
    {
      id: OSM_OUTSIDE_LAYER,
      type: "fill-extrusion",
      source: template.source,
      "source-layer": template.sourceLayer,
      // Inherit the style's own zoom range - the basemap already decided
      // when its buildings appear (Track A lesson: do not override it).
      ...(template.minzoom === undefined ? {} : { minzoom: template.minzoom }),
      ...(template.maxzoom === undefined ? {} : { maxzoom: template.maxzoom }),
      // The local source is already geographically bounded. Draw it
      // immediately, then let the deferred scan remove zone-touching ids;
      // starting empty left a visible 3D hole when local tiles loaded before
      // the first idle callback.
      filter: ["!", ["in", ["id"], ["literal", []]]],
      paint: {
        "fill-extrusion-color": COLORS.osm,
        "fill-extrusion-height": heightExpression,
        "fill-extrusion-base": baseExpression,
        "fill-extrusion-opacity": 0.55,
      },
    },
    firstSymbol,
  );

  // The re-draw layer for straddlers' outside parts. Same look and zoom
  // range: to the eye these ARE osm-outside buildings, just routed through
  // GeoJSON because no filter can cut one feature apart.
  map.addSource(OSM_STRADDLE_SOURCE, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addLayer(
    {
      id: OSM_STRADDLE_LAYER,
      type: "fill-extrusion",
      source: OSM_STRADDLE_SOURCE,
      ...(template.minzoom === undefined ? {} : { minzoom: template.minzoom }),
      ...(template.maxzoom === undefined ? {} : { maxzoom: template.maxzoom }),
      paint: {
        "fill-extrusion-color": COLORS.osm,
        "fill-extrusion-height": heightExpression,
        "fill-extrusion-base": baseExpression,
        "fill-extrusion-opacity": 0.55,
      },
    },
    firstSymbol,
  );

  map.addLayer(
    {
      id: KOSM_SELECTED_LAYER,
      type: "fill-extrusion",
      source: template.source,
      "source-layer": template.sourceLayer,
      ...(template.minzoom === undefined ? {} : { minzoom: template.minzoom }),
      ...(template.maxzoom === undefined ? {} : { maxzoom: template.maxzoom }),
      filter: ["in", ["id"], ["literal", []]],
      paint: {
        "fill-extrusion-color": SELECT_COLOR,
        "fill-extrusion-height": heightExpression,
        "fill-extrusion-base": baseExpression,
        "fill-extrusion-opacity": 0.82,
      },
    },
    firstSymbol,
  );

  // `within` alone leaves OSM buildings standing on the zones. Two
  // separate reasons, both of which Track A already solved:
  //
  //   1. `within` tests the TILE-CLIPPED geometry, so a building split
  //      across a tile seam has no piece that is fully inside. Measured:
  //      7 wholly-inside buildings survived the filter.
  //   2. A building only PARTLY over a zone is not "within" it at all, so
  //      it keeps its whole footprint - including the half sitting on our
  //      massing. Measured: 24 more.
  //
  // The rule is Track A's: an id that TOUCHES a zone is excluded outright,
  // and the parts of it lying outside are re-drawn from GeoJSON. Nothing
  // OSM draws is left overlapping the site.
  // Per-zone bounding boxes, and their union. The exact test below is
  // O(building vertices x zone vertices), and this site has 3,298 zone
  // vertices against Track A's 5 - measured, the vertex half alone took
  // 3.6 s per scan and ran on every `idle`, which is the startup lag.
  // Nearly every building in view is nowhere near a zone, so a box test
  // rejects it for a few comparisons instead of a few thousand.
  const geomBox = (geometry) => {
    const polys =
      geometry.type === "MultiPolygon"
        ? geometry.coordinates
        : [geometry.coordinates];
    let minX = 180;
    let minY = 90;
    let maxX = -180;
    let maxY = -90;
    for (const poly of polys) {
      for (const [x, y] of poly[0]) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    return { minX, minY, maxX, maxY };
  };
  const boxesOverlap = (a, b) =>
    a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;

  const state = {
    flags: new Map(),
    hidden: new Set(),
    parts: new Map(),
    seen: new Set(),
  };
  const refresh = () => {
    if (!map.getLayer(OSM_OUTSIDE_LAYER)) return 0;
    const started = performance.now();
    const before = state.hidden.size;
    const found = map.queryRenderedFeatures({
      layers: [OSM_OUTSIDE_LAYER],
    });
    /** Features actually examined this scan; the harvest works off these. */
    const examined = [];

    // Facts only ever turn true, so a later tile can reveal an outside
    // piece but never take one away.
    for (const f of found) {
      if (f.id === undefined) continue;
      // Test each id ONCE per tile it arrives in, not once per scan.
      // Render queries return the same features again after every source
      // update, and re-running the exact test on the ~80 near the site kept
      // each scan at 288 ms no matter how little had changed. A tile key
      // in the seen-set lets a NEW tile still contribute its piece (which
      // is how a straddler gets promoted) while a repeat costs nothing.
      const tile = f._vectorTileFeature?._z ?? 0;
      const seenKey = `${f.id}@${tile}:${f._vectorTileFeature?._x ?? 0},${f._vectorTileFeature?._y ?? 0}`;
      if (state.seen.has(seenKey)) continue;
      state.seen.add(seenKey);
      let flags = state.flags.get(f.id);
      if (!flags) {
        flags = { touches: false, spills: false };
        state.flags.set(f.id, flags);
      }
      // Cheap rejection next. A building whose box misses the site cannot
      // touch a zone, and is plainly not fully inside one - both facts
      // settled without a single vertex test. The flags are still
      // recorded, exactly as the unoptimised path would: `touches` stays
      // false and `spills` becomes true, which is what Track A's
      // intersectsArea/pieceFullyInside pair would have returned here.
      const box = geomBox(f.geometry);
      if (!boxesOverlap(box, surroundBox)) {
        flags.spills = true;
        continue;
      }
      if (!boxesOverlap(box, siteBox)) {
        flags.spills = true;
        continue;
      }
      flags.touches ||= intersectsArea(f.geometry, zoneUnion);
      flags.spills ||= !pieceFullyInside(f.geometry, zoneUnion);
      examined.push(f);
    }

    state.hidden.clear();
    for (const [id, flags] of state.flags) {
      if (flags.touches) state.hidden.add(id);
    }

    // Harvest the outside sub-polygons of anything that touches AND spills.
    //
    // Keyed by ID, one entry each. Track A keys each sub-polygon by its
    // first vertex, which works against one rectangle; against 48 zone
    // polygons the same building is clipped into slightly different
    // pieces by every tile it appears in, so that key never repeats and
    // the source grew to 9,123 features for 27 buildings.
    // Harvest only what this scan newly examined; `parts` keeps one entry
    // per id across scans, so a straddler clipped better by a later tile
    // replaces its own entry and nothing accumulates.
    let partsAdded = 0;
    for (const f of examined) {
      const flags = state.flags.get(f.id);
      if (!flags?.touches || !flags.spills) continue;
      const g = f.geometry;
      const polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
      const keep = polys.filter((poly) => {
        const sub = { type: "Polygon", coordinates: poly };
        // Same cheap rejection: a piece clear of the site is kept without
        // the exact test.
        if (!boxesOverlap(geomBox(sub), siteBox)) return true;
        return !intersectsArea(sub, zoneUnion);
      });
      if (!keep.length) continue;
      state.parts.set(f.id, {
        type: "Feature",
        // Keep the OSM id, so a drawn part reports as the building it is.
        id: f.id,
        geometry: { type: "MultiPolygon", coordinates: keep },
        properties: { ...f.properties },
      });
      partsAdded += 1;
    }

    if (state.hidden.size !== before) {
      map.setFilter(OSM_OUTSIDE_LAYER, [
        "!",
        ["in", ["id"], ["literal", [...state.hidden]]],
      ]);
    }
    // Set every scan the harvest is non-empty: `parts` is rebuilt rather
    // than appended, so an unchanged count can still mean changed pieces
    // (a tile arriving with a cleaner clip of the same building).
    if (partsAdded !== 0) {
      map.getSource(OSM_STRADDLE_SOURCE)?.setData({
        type: "FeatureCollection",
        features: [...state.parts.values()],
      });
    }
    maskedIds = state.hidden;
    lastScanMs = Math.round(performance.now() - started);
    return state.hidden.size - before;
  };
  let started = false;
  return () => {
    if (started) return;
    started = true;

    // Scan only after the K-OSM source settles. Global `idle` is unreliable
    // here because slow optional terrain can keep the whole map busy after
    // the local vector tiles are already ready.
    let refreshTimer = null;
    const scheduleRefresh = () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        refresh();
      }, 100);
    };
    map.on("sourcedata", (event) => {
      if (event.sourceId === template.source && event.isSourceLoaded) {
        scheduleRefresh();
      }
    });
    map.on("moveend", scheduleRefresh);
    // Fallback for a source that completed just before listener registration.
    scheduleRefresh();
  };
}

/** Is every vertex of this piece inside the zones? Mirrors swap.js. */
function pieceFullyInside(geometry, union) {
  const polys =
    geometry.type === "MultiPolygon"
      ? geometry.coordinates
      : [geometry.coordinates];
  for (const poly of polys) {
    for (const [x, y] of poly[0]) {
      if (!pointInZones(x, y, union)) return false;
    }
  }
  return true;
}

/** Ray-cast against the zone union; mirrors swap.js pointInRing. */
function pointInZones(lon, lat, union) {
  for (const poly of union.coordinates) {
    const ring = poly[0];
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat) {
        if (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    if (inside) return true;
  }
  return false;
}

/** Colour by use - the default and only colouring here. */
function useColorExpression() {
  const { _other, ...uses } = COLORS.byUse;
  return [
    "match",
    ["get", "use"],
    ...Object.entries(uses).flat(),
    _other,
  ];
}

/** floors x per-use storey metres; the slider this page does not have. */
function heightOf(properties) {
  const storey = USE_STOREY_M[properties.use] ?? USE_STOREY_M._default;
  return (properties.floors || 1) * storey;
}

/**
 * What the map should show: the extracted buildings, minus the ones in a
 * simulated zone, plus that zone's generated masses.
 *
 * `data` is never mutated - the scenario is a diff over it, so hiding the
 * simulation restores the originals with no refetch. Same rule as Track
 * A's buildings._rendered().
 */
function scenarioRendered() {
  if (!data) return { type: "FeatureCollection", features: [] };
  if (!simVisible || simZones.size === 0) return data;
  const replaced = new Set(simZones.keys());
  const features = data.features.filter(
    (f) => !replaced.has(f.properties.zone_fid),
  );
  for (const sim of simZones.values()) features.push(...sim.features);
  return { type: "FeatureCollection", features };
}

function rendered() {
  return SNAPSHOT === "before" ? data : scenarioRendered();
}

/** Push the current composition to the map. */
function refreshSite() {
  // The comparison's left source is immutable after startup.
  if (!IS_COMPARISON) updateSiteSource?.(rendered());
  updateAfterSource?.(scenarioRendered());
}

/** Signed shoelace area of a ring in m2; mirrors buildings.js ringArea. */
function ringArea(ring, lat) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  const mPerLon = 111320 * Math.cos((lat * Math.PI) / 180);
  return (Math.abs(sum) / 2) * mPerLon * 110540;
}

/** Footprint area, derived here rather than shipped in the extraction. */
function footprintArea(feature) {
  const g = feature.geometry;
  const polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
  let total = 0;
  for (const poly of polys) {
    total += ringArea(poly[0], poly[0][0][1]);
  }
  return total;
}

/**
 * Draw fewer buildings as the camera pulls back; identical rule to Track
 * A's (LOD_STEPS in config.js), so the two pages thin the same data the
 * same way. Tall OR large survives - storeys alone would drop a sprawling
 * low market and a small shed together.
 */
function zoomFilter() {
  const floorStep = ["step", ["zoom"]];
  const areaStep = ["step", ["zoom"]];
  LOD_STEPS.forEach(([zoom, minFloors, minArea], i) => {
    // A `step` expression takes its first output before any stop, so the
    // opening zoom is implicit and must not be emitted as a stop value.
    if (i === 0) {
      floorStep.push(minFloors);
      areaStep.push(minArea);
    } else {
      floorStep.push(zoom, minFloors);
      areaStep.push(zoom, minArea);
    }
  });
  return [
    "any",
    [">=", ["get", "floors"], floorStep],
    [">=", ["get", "area_m2"], areaStep],
  ];
}

status("건물 불러오는 중...");
let data = null;
let useLegend = [];
let updateSiteSource;
let updateAfterSource;
try {
  data = await siteDataReady;
  for (const f of data.features) {
    f.properties.height_m = heightOf(f.properties);
    f.properties.area_m2 = Math.round(footprintArea(f));
    f.properties.sel_id = f.id ?? f.properties.gid;
  }

  map.addSource(SITE_SOURCE, {
    type: "geojson",
    data: IS_COMPARISON ? data : rendered(),
  });
  updateSiteSource = createGeoJSONUpdater(map.getSource(SITE_SOURCE), data);
  map.addLayer(
    {
      id: SITE_LAYER,
      type: "fill-extrusion",
      source: SITE_SOURCE,
      filter: zoomFilter(),
      paint: {
        "fill-extrusion-color": useColorExpression(),
        "fill-extrusion-height": ["get", "height_m"],
        "fill-extrusion-opacity": 1,
      },
    },
    firstSymbol,
  );
  map.addLayer(
    {
      id: SELECTED_LAYER,
      type: "fill-extrusion",
      source: SITE_SOURCE,
      filter: ["==", ["to-string", ["get", "sel_id"]], "-1"],
      paint: {
        "fill-extrusion-color": SELECT_COLOR,
        "fill-extrusion-height": ["get", "height_m"],
        "fill-extrusion-opacity": 1,
      },
    },
    firstSymbol,
  );
  status(`건물 ${data.features.length.toLocaleString()}동`);
} catch (err) {
  status(`건물 로드 실패: ${err.message}`);
  console.error(err);
}

let startSurroundMasking = null;
try {
  zones.data = await zoneDataReady;
  zones.addLayers(SITE_LAYER);

  map.addLayer(
    {
      id: SIM_ZONE_FILL_LAYER,
      type: "fill",
      source: ZONES_SOURCE,
      filter: ["in", ["get", "fid"], ["literal", [-1]]],
      paint: { "fill-color": SIM_ZONE_COLOR, "fill-opacity": 0.1 },
    },
    SITE_LAYER,
  );
  // Keep the glow static. Mutating paint on every animation frame keeps
  // MapLibre rendering forever, makes camera movement janky, and prevents
  // the `idle` event that triggers the finished-tile OSM surround scan.
  const glowStops = [
    { width: 26, blur: 20, opacity: 0.4 },
    { width: 14, blur: 10, opacity: 0.55 },
    { width: 7, blur: 4, opacity: 0.7 },
  ];
  glowStops.forEach((stop, index) => {
    map.addLayer(
      {
        id: SIM_ZONE_GLOW_LAYERS[index],
        type: "line",
        source: ZONES_SOURCE,
        filter: ["in", ["get", "fid"], ["literal", [-1]]],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": SIM_ZONE_GLOW_COLOR,
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            13,
            stop.width * 0.85,
            18,
            stop.width,
          ],
          "line-blur": stop.blur,
          "line-opacity": stop.opacity,
        },
      },
      firstSymbol,
    );
  });
  map.addLayer(
    {
      id: SIM_ZONE_LINE_LAYER,
      type: "line",
      source: ZONES_SOURCE,
      filter: ["in", ["get", "fid"], ["literal", [-1]]],
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": SIM_ZONE_COLOR,
        "line-width": 2.6,
        "line-opacity": 1,
      },
    },
    firstSymbol,
  );

  // One MultiPolygon of every zone, for the `within` filter. No real
  // union is needed: the zones do not overlap (a building belongs to
  // exactly one, which is what makes the centroid tagging work), so
  // collecting their rings is enough.
  const zoneUnion = {
    type: "MultiPolygon",
    coordinates: zones.data.features.flatMap((z) =>
      z.geometry.type === "MultiPolygon"
        ? z.geometry.coordinates
        : [z.geometry.coordinates],
    ),
  };
  startSurroundMasking = addOsmOutsideZones(zoneUnion);
  // Ours on top: the surround was inserted at firstSymbol, which puts it
  // above the site layer added earlier.
  if (startSurroundMasking && map.getLayer(SITE_LAYER)) {
    map.moveLayer(SITE_LAYER, firstSymbol);
    map.moveLayer(SELECTED_LAYER, firstSymbol);
  }
  for (const id of [...SIM_ZONE_GLOW_LAYERS, SIM_ZONE_LINE_LAYER]) {
    if (map.getLayer(id)) map.moveLayer(id, firstSymbol);
  }
  status(`${$("status").textContent} · 구역 ${zones.count()}개`);
} catch (err) {
  console.error(`zones unavailable: ${err.message}`);
}

/**
 * Load the mirofish scenario and draw it, before anyone touches a control.
 *
 * After the zones, because the massing engine generates against zone
 * geometry. A missing file is not fatal - the page is still a viewer -
 * but it is reported, since a silently absent simulation looks exactly
 * like one with nothing in it.
 */
function applyScenarioConfig(cfg) {
  scenarioConfig = cfg;
  if (!Array.isArray(cfg?.zones)) throw new Error("zones[] missing");

  simZones.clear();
  simMeta = { scenario: null, status: null };
  selectedBuilding = null;
  selectedId = null;
  selectedKosmId = null;

  const wanted = new Set(cfg.applied ?? cfg.zones.map((z) => z.zone_fid));
  for (const config of cfg.zones) {
    if (!wanted.has(config.zone_fid)) continue;
    const zone = zones.data?.features.find((f) => f.id === config.zone_fid);
    if (!zone) {
      console.warn(`sim: no zone with fid ${config.zone_fid}`);
      continue;
    }
    const { features, report } = config.massing ?? generateMassing(zone, config);
    if (report.error) {
      console.warn(`sim: zone ${config.zone_fid}: ${report.error}`);
      continue;
    }
    // The engine's boundary rule holds here too: a mass that escaped its
    // zone is reported, not drawn.
    const check = verifyInsideZone(features, zone);
    if (!check.ok) {
      console.warn(
        `sim: zone ${config.zone_fid} left its boundary (${check.outsideCount})`,
      );
      continue;
    }
    for (const f of features) {
      // Track B's storey height, not the engine's flat 4.0 m default.
      f.properties.height_m = heightOf(f.properties);
      // Without this the LOD filter reads `area_m2` as missing and drops
      // every generated mass the moment the camera pulls back.
      f.properties.area_m2 ??= Math.round(footprintArea(f));
      f.properties.sel_id = f.id;
    }
    simZones.set(config.zone_fid, { features, report, config });
    simMeta = {
      scenario: config.scenario_basis ?? simMeta.scenario,
      status: config.agreement_status ?? simMeta.status,
    };
  }
  refreshSite();
  refreshSimZoneMark();
  syncSelectionHighlight();
  renderSimPanel();
}

async function setScenarioModel(model) {
  if (!["previous", "current"].includes(model)) return;
  const request = ++scenarioRequest;
  if (model === scenarioModel) return;
  try {
    const cfg = await scenarioDataReady[model];
    if (request !== scenarioRequest) return;
    scenarioModel = model;
    applyScenarioConfig(cfg);
    postComparisonScenario(SNAPSHOT, scenarioPayload());
  } catch (err) {
    console.warn(`simulation unavailable: ${err.message}`);
    status(`${$("status").textContent} · 시뮬레이션 없음`);
  }
}

if (SNAPSHOT !== "before") {
  try {
    applyScenarioConfig(await scenarioDataReady.current);
    status(`${$("status").textContent} · 시뮬레이션 ${simZones.size}개 구역`);
  } catch (err) {
    console.warn(`simulation unavailable: ${err.message}`);
    status(`${$("status").textContent} · 시뮬레이션 없음`);
  }
}

let comparisonPosition = 50;
let setComparisonPosition = null;
if (IS_COMPARISON && data) {
  const initialAfter = scenarioRendered();
  map.addSource(AFTER_SITE_SOURCE, {
    type: "geojson",
    data: initialAfter,
  });
  updateAfterSource = createGeoJSONUpdater(map.getSource(AFTER_SITE_SOURCE), initialAfter);
  map.addLayer(
    {
      id: AFTER_SITE_LAYER,
      type: "fill-extrusion",
      source: AFTER_SITE_SOURCE,
      filter: zoomFilter(),
      paint: {
        "fill-extrusion-color": useColorExpression(),
        "fill-extrusion-height": ["get", "height_m"],
        "fill-extrusion-opacity": 1,
      },
    },
    firstSymbol,
  );
  map.addLayer(
    {
      id: AFTER_SELECTED_LAYER,
      type: "fill-extrusion",
      source: AFTER_SITE_SOURCE,
      filter: ["==", ["to-string", ["get", "sel_id"]], "-1"],
      paint: {
        "fill-extrusion-color": SELECT_COLOR,
        "fill-extrusion-height": ["get", "height_m"],
        "fill-extrusion-opacity": 1,
      },
    },
    firstSymbol,
  );
  const applyComparisonPosition = addComparisonCurtain(
    map,
    SITE_LAYER,
    AFTER_SITE_LAYER,
    firstSymbol,
  );
  // Zone marks describe the scenario as a whole, so keep them outside the
  // WebGL scissor stack used only by before/after building extrusions.
  for (const id of SIM_ZONE_LAYERS) {
    if (map.getLayer(id)) map.moveLayer(id, firstSymbol);
  }
  setComparisonPosition = (next) => {
    comparisonPosition = applyComparisonPosition(next);
    return comparisonPosition;
  };
}

// Keep the original basemap hierarchy intact. Symbols sit above the subdued
// OSM context but below the opaque project massing. In comparison mode they
// must precede the left clip layer so the curtain never clips the labels.
moveBasemapSymbolsBelow(IS_COMPARISON && data ? LEFT_CLIP : SITE_LAYER);

// Frame the site: the camera the page opens on is computed from the zones
// themselves, so a change to the site moves the framing with it.
if (zones.data) {
  let minX = 180;
  let minY = 90;
  let maxX = -180;
  let maxY = -90;
  for (const z of zones.data.features) {
    for (const ring of z.geometry.coordinates) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  const cam = map.cameraForBounds(
    [
      [minX, minY],
      [maxX, maxY],
    ],
    { padding: 80, bearing: -15 },
  );
  map.jumpTo({ ...cam, pitch: 55 });
}
document.documentElement.classList.add("viewer-ready");
const startupResources = performance.getEntriesByType("resource");
const resourceStart = (needle) =>
  startupResources.find((entry) => entry.name.includes(needle))?.startTime;
document.documentElement.dataset.viewerReadyMs = String(
  Math.round(performance.now()),
);
for (const [name, needle] of [
  ["styleStartMs", "styles/liberty"],
  ["siteStartMs", "site_buildings.geojson"],
  ["zonesStartMs", "zones.geojson"],
]) {
  const started = resourceStart(needle);
  if (started !== undefined) {
    document.documentElement.dataset[name] = String(Math.round(started));
  }
}

// --- legend -----------------------------------------------------------
//
// Built from the data, not the palette: only uses that exist on site get
// a row, with their counts, so the legend doubles as a verification
// readout. 자동차관련시설 has no colour of its own and lands on _other.

{
  const counts = new Map();
  for (const f of data?.features ?? []) {
    const use = f.properties.use || "(없음)";
    counts.set(use, (counts.get(use) ?? 0) + 1);
  }
  useLegend = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([use, count]) => ({
      use,
      count,
      color: COLORS.byUse[use] ?? COLORS.byUse._other,
    }));
  $("legend").innerHTML = useLegend
    .map(({ use, count, color }) => {
      return (
        `<div class="legend"><span class="swatch" style="background:${color}"></span>` +
        `${use}<span class="count">${count.toLocaleString()}</span></div>`
      );
    })
    .join("");
}

// --- simulation panel -------------------------------------------------
//
// Two states in one panel: the per-zone summary of what the scenario
// does, and - when a building is clicked - what that one building is.
// The summary answers "what changes here"; the detail answers "what is
// this", and both come from the engine's own report rather than being
// recomputed, so the panel cannot drift from what was drawn.

const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

const zoneLabel = (fid) => {
  const p = zones.get(fid);
  return p ? `구역 ${p.zone_dtl || p.zone}` : `fid ${fid}`;
};

const row = (k, v) =>
  `<div class="zone-row"><span>${esc(k)}</span><span class="v">${esc(v)}</span></div>`;
const percent = (value) =>
  Number(value).toLocaleString("ko-KR", {
    maximumFractionDigits: 1,
    useGrouping: false,
  });

const INFERRED_KR = {
  far: "용적률",
  floors: "층수",
  count: "동수",
  anchor: "배치",
  aspect: "형상비",
  use: "용도",
  green_ratio: "녹지율",
};

function inferredEntries(object, prefix = "") {
  return Object.entries(object?.inferred ?? {}).map(([key, basis]) => [
    prefix + (INFERRED_KR[key] ?? key),
    basis,
  ]);
}

function inferredBlock(entries) {
  if (!entries.length) return "";
  const lines = entries
    .map(([label, basis]) => `${esc(label)}: ${esc(basis)}`)
    .join("<br>");
  return (
    `<div class="inferred-note"><span class="inferred-title">추론값 (보고서 미확정)</span>` +
    `<br>${lines}</div>`
  );
}

function demolitionCount(fid) {
  return data.features.filter(
    (feature) =>
      feature.properties.zone_fid === fid &&
      (feature.properties.area_m2 ?? 0) >= MIN_DEMOLITION_AREA_M2,
  ).length;
}

function renderSimSummary() {
  $("sim-meta").innerHTML = simMeta.scenario
    ? `${esc(simMeta.scenario)}<br>${esc(simMeta.status ?? "")}`
    : "";

  if (simZones.size === 0) {
    $("sim-body").innerHTML =
      "<span style='color:#999'>시뮬레이션 결과 없음</span>";
    return;
  }

  const cards = [];
  for (const [fid, sim] of simZones) {
    const r = sim.report;
    const masses = sim.features
      .map((f) => {
        const p = f.properties;
        const color = COLORS.byUse[p.use] ?? COLORS.byUse._other;
        return (
          `<div class="mass-chip"><span class="swatch" style="background:${color}"></span>` +
          `${esc(p.use)} · ${p.floors}층 · ${p.area_m2.toLocaleString()}㎡</div>`
        );
      })
      .join("");
    cards.push(
      `<div class="zone-card">` +
        `<div class="zone-name">${esc(zoneLabel(fid))} <span style="color:#999;font-weight:400">fid ${fid}</span></div>` +
        (scenarioModel === "previous"
          ? row("기존 → 신규", `${demolitionCount(fid)}동 철거 → ${r.placed}동`)
          : row("반영후", `${r.placed}동 유지`)) +
        row("용적률", `${percent(r.achievedFar)}% / 목표 ${percent(r.targetFar)}%`) +
        row("연면적", `${r.achievedGfaM2.toLocaleString()}㎡`) +
        row("대지 / 가용", `${r.siteAreaM2.toLocaleString()} / ${r.buildableAreaM2.toLocaleString()}㎡`) +
        row("녹지 · 이격", `${Math.round(r.greenRatio * 100)}% · ${r.setbackM}m`) +
        masses +
        inferredBlock([
          ...inferredEntries(sim.config),
          ...sim.config.buildings.flatMap((building) =>
            inferredEntries(building, `${building.use} `),
          ),
        ]) +
        `</div>`,
    );
  }
  $("sim-body").innerHTML =
    cards.join("") +
    `<div class="sim-hint">건물을 클릭하면 상세를 봅니다.</div>`;
}

function renderBuildingDetail(props) {
  const back = `<span class="back-link" id="sim-back">← 구역 요약으로</span>`;
  const color = COLORS.byUse[props.use] ?? COLORS.byUse._other;
  const title =
    `<div class="detail-title">` +
    `<span class="swatch" style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${color};margin-right:5px"></span>` +
    `${esc(props.use || "(용도 없음)")}</div>`;

  if (props.dataset === "K-OSM") {
    const metric = (value, unit) =>
      Number.isFinite(Number(value)) && Number(value) > 0
        ? `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 })}${unit}`
        : "—";
    $("sim-body").innerHTML =
      back +
      title +
      row("데이터", "K-OSM") +
      (props.name ? row("명칭", props.name) : "") +
      row("주용도", props.use || "—") +
      row("건물 유형", props.kind || "—") +
      row("층수", props.floors ? `${props.floors}층` : "—") +
      row("높이", metric(props.height_m, "m")) +
      row("높이 산정", props.height_basis || "—") +
      row("건축면적", metric(props.footprint_area_m2, "㎡")) +
      row("연면적", metric(props.gross_floor_area_m2, "㎡")) +
      row("K-OSM ID", props.id ?? "—");
    return;
  }

  const storey = USE_STOREY_M[props.use] ?? USE_STOREY_M._default;
  const common =
    row("층수 / 높이", `${props.floors}층 · ${props.height_m.toFixed(1)}m`) +
    row("층고", `${storey}m (용도 기준)`) +
    row("바닥면적", `${(props.area_m2 ?? 0).toLocaleString()}㎡`);

  if (!props.generated) {
    // An existing NGII building. Say whether the scenario removes it.
    const doomed = simZones.has(props.zone_fid);
    const fate = doomed
      ? `<div class="detail-note">이 건물은 시뮬레이션 적용 시 철거됩니다 (현재 '표시' 꺼짐 상태).</div>`
      : "";
    $("sim-body").innerHTML =
      back +
      title +
      common +
      row("구역", props.zone_fid ? zoneLabel(props.zone_fid) : "구역 밖") +
      (props.name ? row("명칭", props.name) : "") +
      (props.kind ? row("종류", props.kind) : "") +
      row("gid", props.gid ?? "-") +
      fate;
    return;
  }

  // A generated mass: pair it with its config entry and the zone report.
  const sim = simZones.get(props.zone_fid);
  const entry = sim?.config.buildings.find((b) => b.use === props.use);
  const massReport = sim?.report.masses.find(
    (m) => m.use === props.use && m.storeys === props.floors,
  );
  const gfa = (props.area_m2 ?? 0) * props.floors;
  const anchorText = { S: "청계천 방향 (남)", N: "종묘 방향 (북)", E: "동", W: "서" };

  $("sim-body").innerHTML =
    back +
    title +
    row("구분", "시뮬레이션 신규 매스") +
    row("구역", zoneLabel(props.zone_fid)) +
    common +
    row("연면적", `${gfa.toLocaleString()}㎡`) +
    (entry ? row("용적률 기여", `${entry.far}%`) : "") +
    (massReport && massReport.targetFootprint !== massReport.achievedFootprint
      ? row(
          "목표 바닥면적",
          `${massReport.targetFootprint.toLocaleString()}㎡ (미달)`,
        )
      : "") +
    (entry?.anchor ? row("배치", anchorText[entry.anchor] ?? entry.anchor) : "") +
    (entry?.aspect ? row("형상비", `${entry.aspect} (남북 연장)`) : "") +
    (entry?.note ? `<div class="detail-note">${esc(entry.note)}</div>` : "") +
    inferredBlock([
      ...inferredEntries(entry),
      ...inferredEntries(sim?.config, "구역 "),
    ]);
}

function renderSimPanel() {
  if (selectedBuilding) renderBuildingDetail(selectedBuilding);
  else renderSimSummary();
}

// Delegated: the back link is re-created on every render.
$("sim-body").addEventListener("click", (e) => {
  if (e.target.id === "sim-back") viewer.selectBuilding(null);
});

$("sim-toggle").addEventListener("change", (e) => {
  viewer.setSimVisible(e.target.checked);
});

function kosmBuildingProperties(feature) {
  const raw = { ...feature.properties };
  const scale = estimateKosmBuildingScale(raw);

  return {
    ...raw,
    dataset: "K-OSM",
    id: raw.id ?? feature.id,
    name: raw.name ?? null,
    use: raw["building:main_use"] ?? raw.building ?? null,
    kind: raw.building ?? null,
    floors: scale.floors,
    height_m: scale.heightM,
    height_basis: scale.heightBasis,
    footprint_area_m2: scale.footprintAreaM2,
    gross_floor_area_m2: scale.grossFloorAreaM2,
    kosm_feature_id: feature.id ?? null,
  };
}

// Click a project or K-OSM building to inspect it; click empty ground to go back.
map.on("click", (e) => {
  const split = map.getCanvas().clientWidth * (comparisonPosition / 100);
  const siteLayers =
    IS_COMPARISON && e.point.x >= split ? [AFTER_SITE_LAYER] : [SITE_LAYER];
  const siteHits = map.queryRenderedFeatures(e.point, { layers: siteLayers });
  const kosmHits = map.getLayer(OSM_OUTSIDE_LAYER)
    ? map.queryRenderedFeatures(e.point, { layers: [OSM_OUTSIDE_LAYER] })
    : [];
  const building = siteHits.length
    ? { ...siteHits[0].properties }
    : kosmHits.length
      ? kosmBuildingProperties(kosmHits[0])
      : null;
  viewer.selectBuilding(building);
  postComparisonBuilding(SNAPSHOT, building);
});
for (const layer of [
  SITE_LAYER,
  IS_COMPARISON ? AFTER_SITE_LAYER : null,
  OSM_OUTSIDE_LAYER,
].filter(Boolean)) {
  map.on("mouseenter", layer, () => {
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", layer, () => {
    map.getCanvas().style.cursor = "";
  });
}

// --- debug panel + __viewer -------------------------------------------

let fps = 0;
let frames = 0;
let lastSample = performance.now();
map.on("render", () => {
  frames += 1;
  const now = performance.now();
  if (now - lastSample >= 1000) {
    fps = Math.round((frames * 1000) / (now - lastSample));
    frames = 0;
    lastSample = now;
  }
});

/** Drawn count; top 5% trimmed - past ~70 degrees of pitch a query box
 * touching y=0 spans the horizon and returns nothing (see buildings.js). */
function layerDrawnCount(id) {
  const c = map.getCanvas();
  if (!map.getLayer(id)) return 0;
  const h = c.clientHeight;
  return map.queryRenderedFeatures(
    [
      [0, Math.round(h * 0.05)],
      [c.clientWidth, h],
    ],
    { layers: [id] },
  ).length;
}

const drawnCount = () => layerDrawnCount(SITE_LAYER);

const stats = () => {
  const c = map.getCenter();
  const zoneTagged = (data?.features ?? []).filter(
    (feature) => feature.properties.zone_fid != null,
  ).length;
  return {
    lon: +c.lng.toFixed(5),
    lat: +c.lat.toFixed(5),
    zoom: +map.getZoom().toFixed(2),
    pitch: Math.round(map.getPitch()),
    bearing: Math.round(map.getBearing()),
    fps,
    siteLoaded: data?.features.length ?? 0,
    siteDrawn: drawnCount(),
    osmDrawn: layerDrawnCount(OSM_OUTSIDE_LAYER),
    osmStraddleDrawn: layerDrawnCount(OSM_STRADDLE_LAYER),
    osmMasked: maskedIds.size,
    maskScanMs: lastScanMs,
    sim: {
      visible: simVisible,
      zones: simZones.size,
      markedDrawn: layerDrawnCount(SIM_ZONE_LINE_LAYER),
    },
    selectedDrawn:
      layerDrawnCount(SELECTED_LAYER) + layerDrawnCount(AFTER_SELECTED_LAYER),
    zonesLoaded: zones.count(),
    zonesDrawn: zones.drawnCount(),
    zoneTagged,
    useLegend,
  };
};

const debug = $("debug-panel");
const renderDebug = () => {
  const s = stats();
  debug.textContent = [
    `lon/lat  ${s.lon}, ${s.lat}`,
    `zoom     ${s.zoom}   pitch ${s.pitch}   bearing ${s.bearing}`,
    `fps      ${s.fps}`,
    `site     ${s.siteLoaded.toLocaleString()} loaded / ${s.siteDrawn.toLocaleString()} drawn`,
    `OSM      ${s.osmDrawn.toLocaleString()} drawn + ${s.osmStraddleDrawn} parts   masked ${s.osmMasked} (${s.maskScanMs} ms)`,
    `zones    ${s.zonesLoaded} loaded / ${s.zonesDrawn} drawn`,
    `sim      ${s.sim.visible ? "on" : "off"} · ${s.sim.zones} zone(s)`,
  ].join("\n");
};
renderDebug();
if (window.parent === window) setInterval(renderDebug, 500);

const viewer = {
  map,
  getStats: stats,
  waitIdle: (ms) => waitIdle(map, ms),
  flyTo(view) {
    map.jumpTo({
      center: [view.lon ?? view.center[0], view.lat ?? view.center[1]],
      zoom: view.zoom,
      pitch: view.pitch ?? 0,
      bearing: view.bearing ?? 0,
    });
    return waitIdle(map);
  },
  /**
   * Draw the mirofish layer, or hide it. Hiding does not discard: the
   * masses stay in `simZones`, so this is a switch rather than a re-run.
   */
  setSimVisible(visible) {
    simVisible = Boolean(visible);
    $("sim-toggle").checked = simVisible;
    refreshSite();
    refreshSimZoneMark();
    // A detail view of a mass that is no longer drawn would be a lie.
    if (!simVisible && selectedBuilding?.generated) {
      selectedBuilding = null;
      selectedId = null;
      syncSelectionHighlight();
    }
    renderSimPanel();
    return simVisible;
  },
  /** What the scenario holds, per zone, with the engine's own numbers. */
  simInfo() {
    const out = {};
    for (const [fid, sim] of simZones) {
      out[fid] = {
        masses: sim.features.length,
        achievedFar: sim.report.achievedFar,
        targetFar: sim.report.targetFar,
        boundaryOk: true,
        inferred: [
          ...inferredEntries(sim.config),
          ...sim.config.buildings.flatMap((building) =>
            inferredEntries(building, `${building.use} `),
          ),
        ].map(([label]) => label),
      };
    }
    return { visible: simVisible, zones: out, meta: simMeta };
  },
  /** The full engine reports, for verification. */
  simReports: () =>
    Object.fromEntries([...simZones].map(([fid, s]) => [fid, s.report])),
  /** Inspect one building in the panel (null returns to the summary). */
  selectBuilding(props) {
    selectedBuilding = props ?? null;
    selectedId = props?.dataset === "K-OSM"
      ? null
      : props ? (props.sel_id ?? props.gid ?? null) : null;
    selectedKosmId = props?.dataset === "K-OSM"
      ? (props.kosm_feature_id ?? null)
      : null;
    syncSelectionHighlight();
    renderSimPanel();
    return selectedBuilding;
  },
  /**
   * What is DRAWN at a point, per layer - ours inside a zone, the
   * basemap's outside. Both counts, because "the surround is back" is a
   * claim about the OSM layer that the site count cannot make.
   */
  buildingsAt(lon, lat) {
    const pt = map.project([lon, lat]);
    const at = (id) =>
      map.getLayer(id)
        ? map.queryRenderedFeatures(pt, { layers: [id] })
        : [];
    return {
      site: at(SITE_LAYER).map((f) => ({ ...f.properties })),
      osm: at(OSM_OUTSIDE_LAYER).length,
    };
  },
};

window.__viewer = viewer;

$("show-zones").addEventListener("change", (event) => {
  zones.setVisible(event.target.checked);
});

function scenarioPayload() {
  if (!scenarioConfig) return null;
  return {
    ...scenarioConfig,
    model: scenarioModel,
    zones: scenarioConfig.zones.map((zone) => {
      const sim = simZones.get(zone.zone_fid);
      return {
        ...zone,
        label: zoneLabel(zone.zone_fid),
        demolished: demolitionCount(zone.zone_fid),
        report: sim?.report ?? null,
        masses: (sim?.features ?? []).map((feature) => ({
          ...feature.properties,
        })),
      };
    }),
  };
}

startComparisonBridge(map, SNAPSHOT, {
  getStats: stats,
  scenario: SNAPSHOT !== "before" ? scenarioPayload() : null,
  setScenarioModel,
  setScenarioVisible: (visible) => viewer.setSimVisible(visible),
  selectBuilding: (building) => viewer.selectBuilding(building),
  setComparisonPosition,
});
performance.mark("mimlab-viewer-ready");

// After `viewer` exists: renderSimPanel is safe earlier (a hoisted
// function), but the listeners above call viewer methods, so the first
// paint belongs here rather than at load time.
renderSimPanel();

// Register before the fast local source can finish. The mask itself waits for
// a source-complete event, so this does not put the expensive scan on first
// paint and cannot be held up by optional terrain requests.
if (startSurroundMasking) {
  startSurroundMasking();
}
scheduleTerrain(map);
