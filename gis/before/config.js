// Everything the viewer treats as a knob, in one place.

/**
 * Static K-OSM coverage beyond the project bounds.
 * Three kilometres covers the oblique boss-demo camera without loading a
 * city-wide building set. Snapshot generation and runtime masking share this
 * value so neither can create a second, invisible cutoff.
 */
export const BASEMAP_SURROUND_PADDING_M = 3000;

/**
 * Metres per storey BY USE, for Track B, where the storey height is not a
 * slider but a property of what the building is. Keys are NGII vocabulary,
 * matching COLORS.byUse.
 *
 * Grounded in common floor-to-floor practice rather than any single code
 * (Korean building law sets no per-use storey height): Korean apartments
 * run 2.8-3.0 m floor-to-floor; offices 3.6-4.2 m to carry services above
 * a 2.7 m ceiling; retail 4.5 m and up. Everything else is interpolated
 * from those anchors. `_default` covers uses outside the table (창고 etc.)
 * and buildings with no use at all.
 */
export const USE_STOREY_M = {
  주택: 3.0,
  공동주택: 2.9,
  숙박시설: 3.2,
  교육연구시설: 3.6,
  근린생활시설: 3.8,
  업무시설: 4.0,
  기타시설: 3.5,
  자동차관련시설: 3.5,
  종교시설: 4.5,
  판매시설: 4.5,
  문화및집회시설: 5.0,
  _default: 3.5,
};

// Site-scoped fallback camera. Track B used to inherit Track A's full
// nine-sheet view at zoom 12.6, then jump to the Seun zones after loading.
// Starting here avoids both the visible zoom jump and unnecessary tiles.
export const CAMERA = {
  center: [126.99532, 37.56587],
  zoom: 15.76,
  minZoom: 15,
  pitch: 55,
  bearing: -15,
  maxPitch: 85,
};

// K-OSM is assembled locally in map.js from a bounded static tile snapshot.
// This keeps the experimental swap usable under Vite and static hosting;
// k-osm.kr's public vector-tile endpoint does not allow arbitrary origins.
export const BASEMAP_STYLE = "k-osm";
export const TERRAIN_TILES =
  "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

/** K-OSM's own building layers, hidden while the zone-masked copy is active. */
export const OSM_BUILDING_LAYERS = ["building", "building-3d"];

/**
 * Minimum footprint counted as a building demolished by the scenario.
 * NGII includes 9 m² sheds as building features; excluding them makes an
 * otherwise empty site read "0동 철거" instead of "2동 철거".
 */
export const MIN_DEMOLITION_AREA_M2 = 10;

export const COLORS = {
  ngii: "#d33a2c",
  osm: "#9a9a9a",
  // Colour by 용도 instead of flat red. Off by default: a single colour
  // makes it obvious which dataset is drawing where.
  //
  // Keys are the values NGII actually stores, verbatim - `업무시설`, not
  // `업무`. A generated mass must use the same vocabulary or it falls
  // through to `_other` and reads as unclassified. USES in main.js offers
  // exactly these to the panel for that reason.
  byUse: {
    주택: "#c98a5a",
    근린생활시설: "#7ba7c9",
    기타시설: "#a8a8a8",
    교육연구시설: "#9c7bc9",
    종교시설: "#c9a87b",
    업무시설: "#8fb3a0",
    문화및집회시설: "#d19bb5",
    숙박시설: "#c9c07b",
    판매시설: "#e0915f",
    공동주택: "#b06f4a",
    _other: "#b8b0a4",
  },

  /**
   * Uses the zone update panel offers, in the order it offers them.
   * A subset of byUse: these are what a redevelopment plan actually
   * builds, and every one of them has a colour above.
   */
  buildableUses: [
    "업무시설",
    "판매시설",
    "공동주택",
    "근린생활시설",
    "문화및집회시설",
    "숙박시설",
  ],
};

/**
 * Level of detail for OUR buildings only.
 *
 * This applies to the NGII layer and nothing else. OSM's buildings arrive
 * pre-tiled with their own LOD rules baked in (`building-3d` starts at z14),
 * so the K-OSM masking in main.js inherits the style's zoom range rather than imposing ours.
 * Thinning one dataset by another's rules is what made buildings appear
 * below the zoom the basemap intended.
 *
 * A building survives if it is EITHER tall enough OR large enough. Storeys
 * alone are a poor proxy: at 21,560 buildings the median footprint is 64 m2,
 * so a floors-only rule drops a sprawling 2-storey market and a 2-storey
 * shed together. Keeping either dimension preserves the landmarks that give
 * the skyline its shape while still cutting the small stuff.
 *
 * Thinning stays in the viewer, never in the API. The server used to derive
 * a threshold from bbox area and returned 12.8% of the buildings for one
 * request with nothing on screen to explain why. Filtering here keeps every
 * building client-side, so zooming back in restores them with no refetch.
 *
 * Percentages below are of the 21,560 buildings in the test area.
 */
export const LOD_STEPS = [
  // [minZoom, minFloors, minAreaM2]
  [0, 10, 2000], //  z < 13  : towers and very large footprints  (~1%)
  [13, 5, 500], //  z 13-14 : 5 storeys or 500 m2               (~5%)
  [14, 3, 200], //  z 14-15 : 3 storeys or 200 m2               (~17%)
  [15, 0, 0], //  z >= 15 : everything
];
