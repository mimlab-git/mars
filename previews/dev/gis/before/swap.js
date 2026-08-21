// Replacing OSM buildings with ours inside one area.
//
// The requirement is narrow: inside the area our buildings and nothing else;
// outside it, OSM's buildings exactly as the style drew them; and the rest of
// the map - terrain, roads, water, labels - untouched either way.
//
// Three approaches fail before the fourth works, and the failures are worth
// keeping because each looks correct until measured:
//
//   1. `["!", ["within", polygon]]` on the OSM building layers.
//      ~100 buildings stay standing inside the area. Vector tiles clip
//      features at tile edges, and a clipped fragment is not "within" the
//      polygon, so it passes the filter.
//
//   2. An opaque mask polygon drawn over the area.
//      The style draws roads, bridges and water BEFORE buildings, so a mask
//      placed above the buildings covers all of those too. The area turns
//      into a blank patch.
//
//   3. Hiding the OSM building layers outright.
//      Exact, but global - it erases buildings everywhere, when the whole
//      point is to keep them outside the area.
//
//   4. `[">", ["distance", polygon], 0]` on a re-added layer.
//      Removes everything inside, but ALSO removes buildings far outside:
//      measured 111 of 234 gone, up to 1,225 m beyond the boundary. It is a
//      tile-resolution artifact, not a boundary tolerance, and it worsens
//      with zoom - at one point ~100 m outside the area it kept 5 of 21
//      buildings at z14, 3 of 11 at z15, and 0 at z16 and z17. No threshold
//      fixes that.
//
//   5. Filtering a re-added layer by FEATURE ID, membership judged in JS.
//      This was the design for a while and it fixed the boundary overlap,
//      but it rests on an assumption the data does not honour: that one OSM
//      feature id is one building. It is not. Measured on this basemap, 216
//      of 386 masked features are wider than 300 m, and one id spanned
//      1.9 km as 12 separate MultiPolygon rings - the tiles group many
//      unrelated buildings under a single id. Excluding an id therefore
//      erased every building in that group, most of them far outside the
//      area, which is exactly the sparse gap-toothed pattern that showed up
//      to the west of the boundary: 228 buildings drawn with the swap off,
//      150 with it on, all 78 losses traced to grouped ids.
//
//   6. `["!", ["within", polygon]]` alone. Loses nothing outside - MapLibre
//      evaluates `within` per rendered geometry, so a grouped feature drops
//      only its inside parts. But tile-clipped fragments inside the area are
//      not "within" the polygon and survive: 272 pieces measured, and they
//      are mostly LARGE buildings, which do not hide under ours. Grey blocks
//      stood among the red through City Hall and Myeongdong.
//
//   7. Both combined - `within` for straddlers, an id list for the clipped
//      fragments `within` refuses to call inside. Better on both sides
//      (outside losses 78 -> 0, inside leftovers 272 -> 59), but the 59
//      exposed a second wrong assumption: `within` does NOT evaluate per
//      rendered piece. It judges the whole feature, and a MultiPolygon with
//      sub-polygons on both sides of the boundary is "not within", so ALL
//      of it survives - including the parts standing inside the area. Those
//      59 are unreachable by any filter expression: an id can only be
//      excluded whole, and `within` will not cut a feature partially.
//
//   8. What works: classify every id by where its pieces lie, and treat
//      each class with the only tool that fits it.
//
//        wholly inside  -> excluded by id (safe: nothing of it is outside)
//        straddling     -> excluded by id, and its sub-polygons that do NOT
//                          touch the area re-drawn from a GeoJSON source
//                          (`osm-straddle`) copied out of the tiles. The
//                          sub-polygons that touch the area are dropped -
//                          the NGII building draws there instead.
//        wholly outside -> untouched
//
//      The `within` clause stays in the filter as a safety net for tiles
//      that arrive before their ids are classified. Classification moves
//      one way only (wholly inside -> straddling, never back), so the id
//      sets and the GeoJSON only grow - a straddler must not pop back in
//      when its tile unloads.
//
//      Scale, measured at z14.5: of 1,238 ids on screen, 214 wholly
//      inside, 178 straddling, 846 wholly outside.
//
// Alongside this, the NGII side is cut to the same area (see buildings.js).
// It arrives by bbox, and without that cut our buildings would draw outside
// the boundary on top of OSM's - the doubled buildings seen along the edge.
// Both sides use `intersectsArea`: touching the area is enough, so a
// straddling building is drawn once, by us, sticking out past the boundary
// rather than being sliced in half.

import { AREA, COLORS, OSM_BUILDING_LAYERS } from "./config.js";

export const OSM_OUTSIDE_LAYER = "osm-outside";
export const OSM_STRADDLE_LAYER = "osm-straddle";
const OSM_STRADDLE_SOURCE = "osm-straddle-src";

/** Ray-cast point-in-polygon. Handles holes via even-odd crossing count. */
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat) {
      if (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

export function pointInPolygon(lon, lat, geometry) {
  const polys =
    geometry.type === "MultiPolygon"
      ? geometry.coordinates
      : [geometry.coordinates];
  for (const poly of polys) {
    if (!pointInRing(lon, lat, poly[0])) continue;
    // Inside the outer ring - reject if it falls in a hole.
    let inHole = false;
    for (let i = 1; i < poly.length; i++) {
      if (pointInRing(lon, lat, poly[i])) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

/** Do segments p1-p2 and p3-p4 properly cross or touch? */
function segmentsIntersect(p1, p2, p3, p4) {
  const d = (a, b, c) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return true;
  // Collinear touching counts: a building whose wall lies exactly on the
  // boundary overlaps the area and must be replaced, not drawn twice.
  const onSeg = (a, b, c) =>
    Math.min(a[0], b[0]) <= c[0] &&
    c[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= c[1] &&
    c[1] <= Math.max(a[1], b[1]);
  if (d1 === 0 && onSeg(p3, p4, p1)) return true;
  if (d2 === 0 && onSeg(p3, p4, p2)) return true;
  if (d3 === 0 && onSeg(p1, p2, p3)) return true;
  if (d4 === 0 && onSeg(p1, p2, p4)) return true;
  return false;
}

/** Every outer ring of a Polygon or MultiPolygon. Holes are ignored. */
function outerRings(geometry) {
  const polys =
    geometry.type === "MultiPolygon"
      ? geometry.coordinates
      : [geometry.coordinates];
  return polys.map((poly) => poly[0]).filter((ring) => ring && ring.length > 2);
}

/**
 * Does a building footprint overlap the area at all?
 *
 * Three cases, and all three are needed. Checking only the first misses a
 * building larger than the area, and checking only vertices misses a wall
 * that crosses a corner without either endpoint landing inside:
 *   1. any building vertex inside the area
 *   2. any area vertex inside the building
 *   3. any pair of edges crossing
 *
 * Called per rendered piece, and a piece is a clipped fragment of the real
 * footprint. That is safe here in a way it was NOT for the centroid rule:
 * clipping can only shrink a piece, so a piece that overlaps proves the
 * whole feature overlaps. The centroid rule broke on fragments because a
 * fragment's middle is not the feature's middle; overlap has no such flaw.
 */
export function intersectsArea(geometry, areaGeometry) {
  const areaRings = outerRings(areaGeometry);
  const buildingRings = outerRings(geometry);

  for (const bRing of buildingRings) {
    for (const pt of bRing) {
      if (pointInPolygon(pt[0], pt[1], areaGeometry)) return true;
    }
  }

  for (const aRing of areaRings) {
    for (const pt of aRing) {
      if (pointInPolygon(pt[0], pt[1], geometry)) return true;
    }
  }

  for (const bRing of buildingRings) {
    for (let i = 0; i < bRing.length - 1; i++) {
      for (const aRing of areaRings) {
        for (let j = 0; j < aRing.length - 1; j++) {
          if (segmentsIntersect(bRing[i], bRing[i + 1], aRing[j], aRing[j + 1]))
            return true;
        }
      }
    }
  }
  return false;
}

/** Is every vertex of this piece inside the area? */
function pieceFullyInside(geometry, areaGeometry) {
  for (const ring of outerRings(geometry)) {
    for (const pt of ring) {
      if (!pointInPolygon(pt[0], pt[1], areaGeometry)) return false;
    }
  }
  return true;
}

/**
 * Classify every loaded id and collect the straddlers' outside parts.
 *
 * Per id, two accumulated facts decide the class:
 *   touches - some piece of it overlaps the area
 *   spills  - some piece of it has a vertex outside the area
 * touches && !spills -> wholly inside; touches && spills -> straddling.
 *
 * Both facts only ever turn true, so a class can move wholly-inside ->
 * straddling when a later tile reveals an outside piece, and never back.
 * The direction matters: wrongly excluding an id erases buildings
 * kilometres away (failure 5), so an id is promoted to straddling the
 * moment anything contradicts "wholly inside", and its outside parts are
 * re-drawn from then on. That is why this re-runs on `idle`.
 *
 * For straddling ids, every sub-polygon that does not touch the area is
 * copied into `state.parts` (keyed for dedup - the same sub-polygon
 * arrives again from neighbouring tiles' buffers). Sub-polygons that touch
 * the area are dropped: rule (a), the NGII building draws there.
 */
function classifyIds(map, state) {
  const found = map.querySourceFeatures("openmaptiles", {
    sourceLayer: "building",
  });

  for (const f of found) {
    if (f.id === undefined) continue;
    const touches = intersectsArea(f.geometry, AREA.geometry);
    const spills = !pieceFullyInside(f.geometry, AREA.geometry);
    let flags = state.flags.get(f.id);
    if (!flags) {
      flags = { touches: false, spills: false };
      state.flags.set(f.id, flags);
    }
    flags.touches ||= touches;
    flags.spills ||= spills;
  }

  // Split the touching ids into the two classes.
  state.inside.clear();
  state.straddle.clear();
  for (const [id, flags] of state.flags) {
    if (!flags.touches) continue;
    (flags.spills ? state.straddle : state.inside).add(id);
  }

  // Harvest outside sub-polygons of straddlers from the loaded tiles.
  let partsAdded = 0;
  for (const f of found) {
    if (!state.straddle.has(f.id)) continue;
    const g = f.geometry;
    const polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
    for (const poly of polys) {
      const sub = { type: "Polygon", coordinates: poly };
      if (intersectsArea(sub, AREA.geometry)) continue;
      const p0 = poly[0][0];
      const key = `${f.id}:${p0[0].toFixed(6)},${p0[1].toFixed(6)}:${poly[0].length}`;
      if (state.parts.has(key)) continue;
      state.parts.set(key, {
        type: "Feature",
        // Keep the OSM id so queryRenderedFeatures reports these parts as
        // the same building the tiles would have - the verification scripts
        // compare drawn id sets across swap on/off.
        id: f.id,
        geometry: sub,
        properties: {
          render_height: f.properties.render_height ?? 0,
          render_min_height: f.properties.render_min_height ?? 0,
        },
      });
      partsAdded += 1;
    }
  }
  return partsAdded;
}

/**
 * Add a layer that draws OSM buildings everywhere EXCEPT the swap area.
 * Must be called before the NGII layer so ours draws on top.
 */
export function addOSMOutsideLayer(map, beforeId) {
  // Copy the source binding from the style's own 3D building layer so this
  // stays correct if the basemap changes.
  const template = map.getLayer("building-3d");
  if (!template) {
    console.warn("style has no building-3d layer; OSM swap unavailable");
    return false;
  }

  try {
    map.addLayer(
      {
        id: OSM_OUTSIDE_LAYER,
        type: "fill-extrusion",
        source: template.source,
        "source-layer": template.sourceLayer,
        // Inherit the style's zoom range. OSM's buildings are pre-tiled and
        // carry their own level-of-detail rules; `building-3d` starts at z14,
        // and drawing it below that shows buildings the basemap never
        // intended to draw. Our storey/area thinning is for OUR data only -
        // it must not reach into a dataset that already solved this its own
        // way.
        //
        // Spread rather than assign: the style sets minzoom but no maxzoom,
        // and MapLibre rejects an explicit `maxzoom: undefined` outright
        // ("number expected, undefined found") instead of ignoring it.
        ...(template.minzoom === undefined
          ? {}
          : { minzoom: template.minzoom }),
        ...(template.maxzoom === undefined
          ? {}
          : { maxzoom: template.maxzoom }),
        // `within` alone to begin with; refreshInsideIds adds the id clause
        // once tiles have been observed.
        filter: ["!", ["within", AREA.feature]],
        paint: {
          // Translucent, so any building of ours underneath shows through
          // and overlap is immediately visible rather than hidden.
          "fill-extrusion-color": COLORS.osm,
          "fill-extrusion-height": ["get", "render_height"],
          "fill-extrusion-base": ["get", "render_min_height"],
          "fill-extrusion-opacity": 0.55,
        },
      },
      beforeId,
    );
  } catch (err) {
    console.error(`osm-outside layer failed: ${err.message}`);
    return false;
  }

  // The re-draw layer for straddlers' outside parts. Same look and zoom
  // range as osm-outside - to the eye these ARE osm-outside buildings, just
  // routed through GeoJSON because no filter can cut their feature apart.
  try {
    map.addSource(OSM_STRADDLE_SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer(
      {
        id: OSM_STRADDLE_LAYER,
        type: "fill-extrusion",
        source: OSM_STRADDLE_SOURCE,
        ...(template.minzoom === undefined
          ? {}
          : { minzoom: template.minzoom }),
        ...(template.maxzoom === undefined
          ? {}
          : { maxzoom: template.maxzoom }),
        paint: {
          "fill-extrusion-color": COLORS.osm,
          "fill-extrusion-height": ["get", "render_height"],
          "fill-extrusion-base": ["get", "render_min_height"],
          "fill-extrusion-opacity": 0.55,
        },
      },
      beforeId,
    );
  } catch (err) {
    console.error(`osm-straddle layer failed: ${err.message}`);
    // osm-outside still works without it; straddlers just stay hidden.
  }

  // The `within` half needs no help, but the id half can only classify
  // tiles it has seen, so re-scan whenever the map settles.
  const refresh = () => refreshInsideIds(map);
  map.on("idle", refresh);
  refresh();
  return true;
}

/**
 * Everything learned about ids so far. `flags` is the permanent memory
 * (facts only turn true); `inside`/`straddle` are derived from it each
 * scan; `parts` holds the straddlers' outside sub-polygons for re-drawing.
 */
const idState = {
  flags: new Map(),
  inside: new Set(),
  straddle: new Set(),
  parts: new Map(),
};

/** Re-scan loaded tiles; rebuild the filter and the re-draw source. */
export function refreshInsideIds(map) {
  if (!map.getLayer(OSM_OUTSIDE_LAYER)) return 0;
  const beforeIds = idState.inside.size + idState.straddle.size;
  const partsAdded = classifyIds(map, idState);
  const idsAdded = idState.inside.size + idState.straddle.size - beforeIds;

  if (idsAdded !== 0) {
    // Both classes are excluded by id; they differ only in what happens
    // afterwards (straddlers get their outside parts re-drawn).
    map.setFilter(OSM_OUTSIDE_LAYER, [
      "all",
      ["!", ["within", AREA.feature]],
      [
        "!",
        [
          "in",
          ["id"],
          ["literal", [...idState.inside, ...idState.straddle]],
        ],
      ],
    ]);
  }

  if (partsAdded !== 0) {
    map.getSource(OSM_STRADDLE_SOURCE)?.setData({
      type: "FeatureCollection",
      features: [...idState.parts.values()],
    });
  }
  return idsAdded;
}

/** OSM ids currently excluded inside the area (both classes). */
export function insideIdCount() {
  return idState.inside.size + idState.straddle.size;
}

/**
 * `true`  - our buildings inside the area, OSM's outside.
 * `false` - the basemap's own buildings everywhere, ours hidden.
 */
export function setSwapEnabled(map, enabled) {
  for (const id of OSM_BUILDING_LAYERS) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, "visibility", enabled ? "none" : "visible");
    }
  }
  for (const id of [OSM_OUTSIDE_LAYER, OSM_STRADDLE_LAYER]) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, "visibility", enabled ? "visible" : "none");
    }
  }
}

export function isSwapEnabled(map) {
  return map.getLayer(OSM_OUTSIDE_LAYER)
    ? map.getLayoutProperty(OSM_OUTSIDE_LAYER, "visibility") !== "none"
    : false;
}
