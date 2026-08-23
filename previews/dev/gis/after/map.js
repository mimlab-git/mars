// Map creation, world terrain, and camera helpers.

import { BASEMAP_STYLE, CAMERA, CINEMATIC, COLORS, TERRAIN_TILES } from "./config.js";

/** Create the map and wait until its style has loaded. */
export async function createMap(container = "map") {
  const map = new maplibregl.Map({
    container,
    style: BASEMAP_STYLE,
    ...CAMERA,
  });
  // The full `load` event waits for the first basemap tiles too. Our local
  // GeoJSON layers only require the style graph, so let map tiles continue
  // streaming while the useful site model is built.
  await new Promise((resolve) => map.once("style.load", resolve));

  return map;
}

/**
 * Add terrain after the useful map is already visible.
 *
 * The remote DEM is visual enhancement, not a prerequisite for the site
 * model. Starting it on the critical path made both comparison frames fetch,
 * decode, and upload terrain tiles while they were still booting.
 */
export function scheduleTerrain(map) {
  let started = false;
  const start = () => {
    if (started || map.getSource("dem")) return;
    started = true;

    try {
      // World terrain. The DEM arrives as RGB-encoded raster tiles and the
      // GPU turns them into relief.
      map.addSource("dem", {
        type: "raster-dem",
        tiles: [TERRAIN_TILES],
        encoding: "terrarium",
        tileSize: 256,
        maxzoom: 15,
      });
      map.setTerrain({ source: "dem", exaggeration: 1 });
    } catch (err) {
      console.warn(`terrain unavailable (${err.message})`);
    }
  };

  const connection = navigator.connection;
  const constrained = Boolean(
    connection?.saveData ||
      (navigator.deviceMemory && navigator.deviceMemory <= 4) ||
      (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4),
  );

  const startWhenIdle = () => {
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(start, { timeout: constrained ? 5000 : 2000 });
    } else {
      window.setTimeout(start, constrained ? 2500 : 800);
    }
  };

  if (constrained) {
    // Older hardware keeps the flat, useful model until the user chooses to
    // explore it. Terrain then starts during the next idle window.
    map.getCanvas().addEventListener("pointerdown", startWhenIdle, { once: true });
    return;
  }

  startWhenIdle();
}

/** Camera views from scripts/views.json, keyed by name. */
export async function loadViews() {
  try {
    const res = await fetch(new URL("./views.json", import.meta.url));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const views = await res.json();
    // `_note` and friends are documentation, not views.
    return Object.fromEntries(
      Object.entries(views).filter(([k]) => !k.startsWith("_")),
    );
  } catch (err) {
    console.warn(`views.json unavailable (${err.message})`);
    return {};
  }
}

/** OSM surround layers to tone down; ids match swap.js. */
const SURROUND_LAYERS = ["osm-outside", "osm-straddle"];

/**
 * Atmosphere, sun, and a desaturated surround - on or off.
 *
 * Off restores the values the layers were built with rather than deleting
 * the properties: MapLibre treats a removed paint property as "use the
 * spec default", which for fill-extrusion-opacity is 1, not the 0.55
 * swap.js chose. Reading them back at first use would work too, but the
 * constants are already the single source for this look.
 *
 * Returns the state actually applied, so a caller can report it rather
 * than assume it.
 */
export function applyCinematic(map, on) {
  map.setSky(on ? CINEMATIC.sky : {});
  map.setLight(
    on ? CINEMATIC.light : { anchor: "viewport", position: [1.15, 210, 30] },
  );

  for (const id of SURROUND_LAYERS) {
    if (!map.getLayer(id)) continue;
    map.setPaintProperty(
      id,
      "fill-extrusion-color",
      on ? CINEMATIC.surroundColor : COLORS.osm,
    );
    map.setPaintProperty(
      id,
      "fill-extrusion-opacity",
      on ? CINEMATIC.surroundOpacity : 0.55,
    );
  }
  return on;
}

/**
 * Resolves once the map has finished loading tiles and settled.
 * Screenshots taken before this are unreliable.
 */
export async function waitIdle(map, timeoutMs = 30000) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (map.loaded() && map.areTilesLoaded()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
