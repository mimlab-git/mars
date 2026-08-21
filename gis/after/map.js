// Map creation, world terrain, and camera helpers.

import { BASEMAP_STYLE, CAMERA, CINEMATIC, COLORS, TERRAIN_TILES } from "./config.js";

/** Create the map and wait until its style has loaded. */
export async function createMap(container = "map") {
  const map = new maplibregl.Map({
    container,
    style: BASEMAP_STYLE,
    ...CAMERA,
  });
  await new Promise((resolve) => map.on("load", resolve));

  // World terrain. No build step of our own: the DEM arrives as RGB-encoded
  // raster tiles and the GPU turns them into relief. This replaces the
  // quantized-mesh pipeline the project used to run for 10 minutes a build.
  map.addSource("dem", {
    type: "raster-dem",
    tiles: [TERRAIN_TILES],
    encoding: "terrarium",
    tileSize: 256,
    maxzoom: 15,
  });
  map.setTerrain({ source: "dem", exaggeration: 1 });

  return map;
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
