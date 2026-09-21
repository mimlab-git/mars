// Map creation, world terrain, and camera helpers.

import { BASEMAP_STYLE, CAMERA, TERRAIN_TILES } from "./config.js";
import { buildKosmStyle } from "./kosm-style.js";

/** Create the map and wait until its style has loaded. */
export async function createMap(container = "map") {
  let snapshotBounds;
  let cameraBounds;
  if (BASEMAP_STYLE === "k-osm") {
    try {
      const response = await fetch(
        new URL("../data/kosm-tiles/manifest.json", import.meta.url),
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const manifest = await response.json();
      if (
        Array.isArray(manifest.bounds) &&
        manifest.bounds.length === 4 &&
        manifest.bounds.every(Number.isFinite)
      ) {
        snapshotBounds = manifest.bounds;
      }
      if (
        Array.isArray(manifest.camera_bounds) &&
        manifest.camera_bounds.length === 4 &&
        manifest.camera_bounds.every(Number.isFinite)
      ) {
        cameraBounds = manifest.camera_bounds;
      }
    } catch (error) {
      console.warn(`K-OSM snapshot bounds unavailable (${error.message})`);
    }
  }

  const map = new maplibregl.Map({
    container,
    style:
      BASEMAP_STYLE === "k-osm"
        ? buildKosmStyle(snapshotBounds)
        : BASEMAP_STYLE,
    localIdeographFontFamily: "'Noto Sans KR', 'Apple SD Gothic Neo', sans-serif",
    ...(cameraBounds
      ? {
          maxBounds: [
            [cameraBounds[0], cameraBounds[1]],
            [cameraBounds[2], cameraBounds[3]],
          ],
        }
      : {}),
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
