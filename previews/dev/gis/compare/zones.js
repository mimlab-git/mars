// The Seun redevelopment zones: the unit that buildings get edited in.
//
// 48 polygons over 0.39 km2 of Euljiro, from the city's 재정비촉진계획.
// Built from a shapefile by scripts/build_zones.py, which is where the
// CRS and geometry repairs are explained.
//
// Two id systems arrive with the data and both are kept, because they
// answer different questions and only one of them is unique:
//
//   fid (1-48)   the polygon. UNIQUE, and therefore the editing key.
//   zone         the planning block (1, 2, 3, 5, 6-1 .. 6-4).
//   zone_dtl     the plan's sub-number ("3-2,3", "6-4-1").
//
// `zone`/`zone_dtl` look like the natural key and are not: 6 of 48 rows
// share a pair with another row, and 5 of those 6 are *different places* -
// 국도호텔 and 덕수중 are 44 m apart and both carry zone 6-3, because the
// detail number was left blank. Keying on the concept would merge them.
// Only 7/9 (을지트윈타워) is genuinely one site split across two polygons.

import { pointInPolygon } from "./swap.js";

export const ZONES_SOURCE = "zones-src";
const SOURCE = ZONES_SOURCE;
export const ZONE_FILL_LAYER = "zones-fill";
export const ZONE_LINE_LAYER = "zones-outline";
export const ZONE_HIGHLIGHT_LAYER = "zone-buildings-highlight";

/** Colour per planning category. Grey is the fallback. */
const TYPE_COLORS = {
  "촉진구역(복합개발용지)": "#e8833a",
  "존치정비구역(복합개발용지)": "#4a90c4",
  "존치정비구역(공원용지)": "#5aa86a",
  "존치관리구역(일반용지)": "#9b8ec4",
  "존치관리구역(기반시설용지)": "#c4a15a",
};

/**
 * Area-weighted centroid of a Polygon or MultiPolygon, in lon/lat.
 *
 * Not a vertex average: that is pulled towards whichever edge carries more
 * vertices, and on an L-shaped footprint it can land outside the building
 * entirely. The shoelace centroid is the real one.
 *
 * The coordinates are shifted so the first vertex is the origin before the
 * shoelace sum, and shifted back afterwards. This is not tidiness - it is
 * required. In raw lon/lat each `x0*y1 - x1*y0` term is around 4,760 while
 * a 64 m2 building's true signed area is around 2e-9, so the sum is the
 * difference of large near-equal numbers and catastrophic cancellation
 * destroys it. Measured before the shift: a building at 126.9734, 37.5632
 * produced a centroid at 126.9926, 37.5689 - two kilometres away, inside
 * an unrelated zone, which tagged 342 buildings wrongly and put buildings
 * in all 48 zones when 4 of them are genuinely empty. Shifted, the terms
 * are metres-scale and the result is exact.
 *
 * Degenerate rings (a true zero-area sliver) fall back to the vertex
 * average, which is still inside the ring's bounding box.
 */
function centroidOf(geometry) {
  const polys =
    geometry.type === "MultiPolygon"
      ? geometry.coordinates
      : [geometry.coordinates];

  const [ox, oy] = polys[0][0][0];

  let cx = 0;
  let cy = 0;
  let area2 = 0;
  for (const poly of polys) {
    const ring = poly[0];
    for (let i = 0; i < ring.length - 1; i++) {
      const x0 = ring[i][0] - ox;
      const y0 = ring[i][1] - oy;
      const x1 = ring[i + 1][0] - ox;
      const y1 = ring[i + 1][1] - oy;
      const cross = x0 * y1 - x1 * y0;
      area2 += cross;
      cx += (x0 + x1) * cross;
      cy += (y0 + y1) * cross;
    }
  }

  if (area2 !== 0) {
    return [cx / (3 * area2) + ox, cy / (3 * area2) + oy];
  }

  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const poly of polys) {
    for (const [x, y] of poly[0]) {
      sx += x;
      sy += y;
      n += 1;
    }
  }
  return n ? [sx / n, sy / n] : [0, 0];
}

export class Zones {
  constructor(map) {
    this.map = map;
    this.data = null;
    this.selected = null;
  }

  async load() {
    const res = await fetch(new URL("../data/zones.geojson", import.meta.url));
    if (!res.ok) throw new Error(`zones.geojson: HTTP ${res.status}`);
    this.data = await res.json();
    return this.data.features.length;
  }

  /**
   * Add the zone layers: a translucent glaze draped over the terrain,
   * plus an outline, both below the buildings.
   *
   * The zones are ground markings, not platforms. Buildings keep sitting
   * on the terrain and therefore pass THROUGH the glaze - a building is
   * not raised onto the zone, and the glaze does not hide its base. That
   * is why these layers go under the buildings: the buildings covering
   * parts of the glaze is the intended result, not an artefact.
   *
   * `fill` and `line` are used because MapLibre drapes them onto the
   * terrain mesh, so they follow the slope exactly. `fill-extrusion`
   * cannot: its `height`/`base` are one absolute elevation for the whole
   * polygon, so over the 28.6 m of relief measured across these zones a
   * slab buries itself at one end and floats at the other.
   *
   * The earlier note here claimed a flat `fill` is invisible whatever the
   * layer order. That was wrong, and the slab it justified is what this
   * replaces. Measured again: the fill drapes correctly and was merely
   * being covered by the buildings standing on it. `queryRenderedFeatures`
   * cannot tell these two cases apart - it is a hit test on geometry, not
   * a visibility check - which is how the wrong conclusion survived. Only
   * a screenshot settles it.
   *
   * The trade-off of draping: `fill` sits exactly on the ground and cannot
   * be lifted along z. The "raised" reading comes from the outline and the
   * colour, not from real height.
   */
  addLayers(beforeId) {
    if (this.map.getSource(SOURCE)) return;
    this.map.addSource(SOURCE, { type: "geojson", data: this.data });

    const color = [
      "match",
      ["get", "zone_type"],
      ...Object.entries(TYPE_COLORS).flat(),
      "#999999",
    ];

    this.map.addLayer(
      {
        id: ZONE_FILL_LAYER,
        type: "fill",
        source: SOURCE,
        paint: {
          "fill-color": color,
          // Translucent, so the streets and plot lines underneath stay
          // readable - the zone marks the ground rather than replacing it.
          "fill-opacity": [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            0.62,
            0.38,
          ],
        },
      },
      beforeId,
    );

    this.map.addLayer(
      {
        id: ZONE_LINE_LAYER,
        type: "line",
        source: SOURCE,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": color,
          "line-width": [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            4,
            2,
          ],
          "line-opacity": 0.95,
        },
      },
      beforeId,
    );
  }

  /**
   * Highlight the selected zone's buildings by re-drawing them in a
   * distinct colour on top of the NGII layer.
   *
   * A second layer over the same source, rather than a colour expression on
   * the NGII layer itself: the highlight then owns its own filter, and
   * switching zones is one `setFilter` instead of rebuilding the paint
   * expression that `colorByUse` also writes to. The two features stay
   * independent.
   *
   * Filtered to nothing until a zone is selected. `["==", ["get",
   * "zone_fid"], -1]` never matches, since fids are 1-48.
   */
  addHighlightLayer(beforeId) {
    if (this.map.getLayer(ZONE_HIGHLIGHT_LAYER)) return;
    this.map.addLayer(
      {
        id: ZONE_HIGHLIGHT_LAYER,
        type: "fill-extrusion",
        source: "ngii",
        filter: ["==", ["get", "zone_fid"], -1],
        paint: {
          "fill-extrusion-color": "#ffd24a",
          "fill-extrusion-height": ["get", "height_m"],
          "fill-extrusion-opacity": 1,
        },
      },
      beforeId,
    );
  }

  /** Point the highlight at one zone's buildings, or clear it with null. */
  highlightBuildings(fid) {
    if (!this.map.getLayer(ZONE_HIGHLIGHT_LAYER)) return;
    this.map.setFilter(ZONE_HIGHLIGHT_LAYER, [
      "==",
      ["get", "zone_fid"],
      fid === null ? -1 : fid,
    ]);
  }

  /**
   * Highlighted buildings actually DRAWN, which is not what was asked for.
   *
   * Box starts below the top edge for the same reason as
   * buildings.drawnCount: past ~70 degrees of pitch a box touching y=0
   * spans the horizon and returns nothing at all.
   */
  highlightDrawnCount() {
    const c = this.map.getCanvas();
    if (!this.map.getLayer(ZONE_HIGHLIGHT_LAYER)) return 0;
    const h = c.clientHeight;
    return this.map.queryRenderedFeatures(
      [
        [0, Math.round(h * 0.05)],
        [c.clientWidth, h],
      ],
      { layers: [ZONE_HIGHLIGHT_LAYER] },
    ).length;
  }

  /**
   * Tag each building with the zone its centroid falls in, as
   * `properties.zone_fid` (null outside every zone).
   *
   * Centroid, never intersection. Measured on this data: by centroid all
   * 1,759 buildings inside the zones land in exactly one zone; by
   * intersection 172 land in two or three, which a per-zone edit cannot
   * resolve - the same building would be modified twice by two configs.
   *
   * The centroid rule is safe here in a way it is NOT in swap.js. These
   * features arrive whole from our own API, so a centroid is the real
   * footprint's centroid. OSM's arrive as tile-clipped pieces, where a
   * piece's middle is not the feature's middle - which is why swap.js
   * judges overlap instead.
   *
   * Returns counts, so the caller can assert rather than assume.
   *
   * Verified against PostGIS with the same rule: 1,759 tagged across 44
   * zones, the same total and the same per-zone counts, except one
   * building. gid 39007 (11 m2, 1 storey) has its centroid 3 mm from the
   * fid 33 / fid 36 boundary, and lands in 33 here where PostGIS says 36.
   * That is the 4326-vs-5186 transform, not a defect in either rule: at
   * three millimetres the two coordinate systems disagree about which side
   * of a line a point is on. It matters only that the building belongs to
   * exactly ONE zone, which it does.
   */
  tagBuildings(features) {
    let tagged = 0;
    for (const f of features) {
      const [lon, lat] = centroidOf(f.geometry);
      let fid = null;
      for (const z of this.data.features) {
        if (pointInPolygon(lon, lat, z.geometry)) {
          fid = z.id;
          break; // One zone by construction; the first hit is the only hit.
        }
      }
      f.properties.zone_fid = fid;
      if (fid !== null) tagged += 1;
    }
    return { tagged, total: features.length };
  }

  /** Building ids assigned to a zone. `gid` is the NGII key. */
  buildingsIn(fid, features) {
    return features
      .filter((f) => f.properties.zone_fid === fid)
      .map((f) => f.properties.gid ?? f.id);
  }

  /** Highlight one zone by fid, or clear with null. Returns its properties. */
  select(fid) {
    if (this.selected !== null) {
      this.map.setFeatureState(
        { source: SOURCE, id: this.selected },
        { selected: false },
      );
    }
    if (fid !== null) {
      this.map.setFeatureState({ source: SOURCE, id: fid }, { selected: true });
    }
    this.selected = fid;
    this.highlightBuildings(fid);
    return fid === null ? null : this.get(fid);
  }

  get(fid) {
    const f = this.data?.features.find((x) => x.id === fid);
    return f ? { ...f.properties } : null;
  }

  setVisible(visible) {
    for (const id of [ZONE_FILL_LAYER, ZONE_LINE_LAYER]) {
      if (this.map.getLayer(id)) {
        this.map.setLayoutProperty(
          id,
          "visibility",
          visible ? "visible" : "none",
        );
      }
    }
  }

  isVisible() {
    return this.map.getLayer(ZONE_FILL_LAYER)
      ? this.map.getLayoutProperty(ZONE_FILL_LAYER, "visibility") !== "none"
      : false;
  }

  count() {
    return this.data?.features.length ?? 0;
  }

  /**
   * Zones currently drawn on screen, which is not the same as loaded.
   * Top strip trimmed - see highlightDrawnCount.
   */
  drawnCount() {
    const c = this.map.getCanvas();
    if (!this.map.getLayer(ZONE_FILL_LAYER)) return 0;
    const h = c.clientHeight;
    const seen = new Set(
      this.map
        .queryRenderedFeatures(
          [
            [0, Math.round(h * 0.05)],
            [c.clientWidth, h],
          ],
          { layers: [ZONE_FILL_LAYER] },
        )
        .map((f) => f.id),
    );
    return seen.size;
  }
}
