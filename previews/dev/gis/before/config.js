// Everything the viewer treats as a knob, in one place.
//
/**
 * The swap area: the ground our NGII data actually covers.
 *
 * The nine 1:5000 sheets tile a 3x3 waffle with no gaps and no overlap -
 * measured from the data, the seams meet within a metre (columns split at
 * x=197791 and x=200000 in EPSG:5186). Each sheet is 2,210 x 2,775 m, and
 * the whole block is 6,629 x 8,325 m = 55.19 km2.
 *
 * The grid is rectangular in WGS84, not in the storage CRS: transforming
 * the four corners of the data extent lands on 126.95/127.025 x
 * 37.525/37.60 to within 0.000048 degrees (~4 m). NGII cuts its sheets on
 * lon/lat, so 0.025 degrees per sheet is the real ruling, and the metre
 * figures above are what that works out to at this latitude.
 *
 * Using the clean grid values rather than the measured extent is
 * deliberate. The measured maximum is a single building overhanging its
 * sheet by a few metres; taking it as the boundary would pin the area to
 * an accident of the data. Against the clean grid, 349 of 127,890
 * buildings cross the edge and 5 fall entirely outside - by at most 0.5 m.
 * The crossing ones are ours to draw (touching is enough, see swap.js);
 * the 5 stay with OSM.
 *
 * An administrative boundary was the original plan for this step. The
 * sheet grid is better: it needs no new table, and it cannot produce the
 * hole a district boundary would where the district leaves our coverage.
 */
export const AREA = (() => {
  const bbox = [126.95, 37.525, 127.025, 37.6];
  const [w, s, e, n] = bbox;
  const geometry = {
    type: "Polygon",
    coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
  };
  return {
    bbox,
    geometry,
    feature: { type: "Feature", properties: {}, geometry },
    label: "NGII 1:5000 도엽 9장 (55.19 km²)",
  };
})();

/** Metres per storey. NGII gives floor counts, not heights. */
export const DEFAULT_FLOOR_HEIGHT = 4.0;

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
  pitch: 55,
  bearing: -15,
  maxPitch: 85,
};

// External data. Both conflict with the project's isolation rule and are a
// deployment decision, not a development one - see docs/M5_TRANSITION_PLAN.md
// section 6.1.
export const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
export const TERRAIN_TILES =
  "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

/** The style's own building layers, hidden while a swap is active. */
export const OSM_BUILDING_LAYERS = ["building", "building-3d"];

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
 * Cinematic styling: atmosphere, sun, and a toned-down surround.
 *
 * A toggle, never the default. The analysis view's flat lighting and full
 * basemap saturation are what the verification workflow measures against,
 * and the counts in a screenshot have to stay readable. This exists to
 * produce the BASE IMAGE for the render pipeline's later AI pass, where
 * what matters is that the massing reads clearly and the surround does
 * not compete with it.
 *
 * The sun sits south-west at a low winter angle: it puts the lit face of
 * a 종묘-facing mass toward the camera in the standard comparison views,
 * and long shadows are what make a massing model read as built rather
 * than as a diagram.
 */
export const CINEMATIC = {
  sky: {
    "sky-color": "#8fb8e0",
    "horizon-color": "#e8d5c0",
    "fog-color": "#dfe6ee",
    "sky-horizon-blend": 0.6,
    "horizon-fog-blend": 0.5,
    "fog-ground-blend": 0.1,
    "atmosphere-blend": 0.7,
  },
  light: {
    anchor: "map",
    // MapLibre's azimuth is degrees clockwise from north (map anchor).
    position: [1.5, 225, 55],
    color: "#fff4e0",
    intensity: 0.45,
  },
  /** OSM surround, desaturated so our massing carries the frame. */
  surroundColor: "#c3c7cc",
  surroundOpacity: 0.85,
};

/**
 * Level of detail for OUR buildings only.
 *
 * This applies to the NGII layer and nothing else. OSM's buildings arrive
 * pre-tiled with their own LOD rules baked in (`building-3d` starts at z14),
 * so `swap.js` inherits the style's zoom range rather than imposing ours.
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
