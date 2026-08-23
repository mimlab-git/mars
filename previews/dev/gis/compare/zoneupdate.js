// Zone update: replace a zone's buildings with a generated massing.
//
// This is the physical end of the mirofish pipeline. An agent simulation
// reports the gesture it wants for a zone, that becomes a configuration
// table, and this module turns those numbers into geometry:
//
//   config -> demolish everything tagged with this zone_fid
//          -> generate new masses inside the zone
//          -> hand the result to buildings.js for re-render
//
// Two rules govern everything here, and both are checkable by counting:
//
//   1. NOTHING may leave the zone. Every vertex of every generated mass
//      must lie inside the zone polygon. Enforced twice - a mass is only
//      placed where its whole outline clears the setback, and the result
//      is then verified vertex by vertex against the zone. A violation is
//      reported and the update refused, never silently clipped.
//   2. The original data is never mutated. A config is a diff; applying it
//      derives a new feature list, and dropping the config restores the
//      original at no cost.
//
// Only two zone types get updated: 존치정비구역(복합개발용지) and
// 촉진구역(복합개발용지) - 28 of the 48. The 존치관리 zones stay as they
// are (that is what 존치관리 means), and the 공원용지 zones are parks.

import { pointInPolygon } from "./swap.js";

/** Zone types whose interior may be rebuilt. */
const UPDATABLE = [
  "존치정비구역(복합개발용지)",
  "촉진구역(복합개발용지)",
];

/** Metres per storey, matching the viewer's own extrusion default. */
const STOREY_M = 4.0;

/**
 * Setback from the zone boundary, in metres. The generated masses live
 * inside this, which is the first of the two guarantees that nothing
 * escapes the zone.
 */
const SETBACK_M = 3;

/** Gap between masses when a zone holds more than one. */
const MASS_GAP_M = 6;

export function isUpdatable(zoneType) {
  return UPDATABLE.includes(zoneType);
}

// --- geometry helpers -------------------------------------------------
//
// Everything works in a local metres frame rather than lon/lat. Degrees
// are not a length: one degree of longitude is 88 km here and one of
// latitude is 111 km, so a setback or a gap expressed in degrees would be
// 26% wider east-west than north-south. Projecting once, working in
// metres, and projecting back keeps the shapes true and the arithmetic
// away from the cancellation that lon/lat shoelace sums suffer.

const M_PER_LAT = 110540;

function metresFrame(ring) {
  const lat0 = ring[0][1];
  const lon0 = ring[0][0];
  const mPerLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  return {
    toM: ([lon, lat]) => [(lon - lon0) * mPerLon, (lat - lat0) * M_PER_LAT],
    toLonLat: ([x, y]) => [lon0 + x / mPerLon, lat0 + y / M_PER_LAT],
  };
}

/** Shoelace area of a ring in whatever units it is expressed in. */
function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(sum) / 2;
}

/** Zone area in square metres, from geometry - never from `zone_area`. */
export function zoneAreaM2(geometry) {
  const rings =
    geometry.type === "MultiPolygon"
      ? geometry.coordinates.map((p) => p[0])
      : [geometry.coordinates[0]];
  const frame = metresFrame(rings[0]);
  let total = 0;
  for (const ring of rings) total += ringArea(ring.map(frame.toM));
  return total;
}

/**
 * Distance from a point to a ring's outline, in the ring's own units.
 * Point-to-segment over every edge, so it is exact for any outline,
 * concave included.
 */
function distanceToOutline(x, y, ring) {
  let best = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((x - ax) * dx + (y - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
    if (d < best) best = d;
  }
  return best;
}

/**
 * Is a point at least `inset` metres inside the ring?
 *
 * This replaces an inward polygon offset. Half-plane clipping - the
 * obvious way to shrink a polygon - was tried first and is WRONG here:
 * Sutherland-Hodgman against every edge converges on the convex hull, and
 * these are concave city blocks of ~116 vertices. Measured on fid 1, it
 * ate 10,523 m² down to 1,200 m² before collapsing entirely, and reported
 * the zone as "too small for a 3 m setback".
 *
 * A true offset needs a straight-skeleton or a clipper library. Neither is
 * warranted: nothing here needs the offset polygon as a polygon, only the
 * question "may a mass occupy this point", which a distance test answers
 * exactly and for any shape.
 */
function isInsetPoint(x, y, ring, inset) {
  if (!inRing(x, y, ring)) return false;
  return distanceToOutline(x, y, ring) >= inset;
}

/**
 * Area of the region lying at least `inset` metres inside the ring,
 * estimated on a grid.
 *
 * Sampling rather than construction, for the same reason as above: the
 * inset region is only ever needed as a quantity. The grid is scaled to
 * the ring so the estimate stays within a fraction of a percent whatever
 * the zone's size.
 */
function insetArea(ring, inset, samples = 90) {
  const b = bounds(ring);
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  const stepX = w / samples;
  const stepY = h / samples;
  const cell = stepX * stepY;
  let area = 0;
  for (let i = 0; i < samples; i++) {
    for (let j = 0; j < samples; j++) {
      const x = b.minX + (i + 0.5) * stepX;
      const y = b.minY + (j + 0.5) * stepY;
      if (isInsetPoint(x, y, ring, inset)) area += cell;
    }
  }
  return area;
}

/** Axis-aligned bounds of a ring. */
function bounds(ring) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** Is a point inside a ring? Ray cast, same rule as swap.js. */
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y) {
      if (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/**
 * Largest axis-aligned rectangle of a given area that fits in a ring,
 * centred on `cx, cy` and grown until it would touch the outline.
 *
 * Rectangles rather than free-form footprints: the shape has to be
 * guaranteed inside a polygon that can be concave, and a rectangle tested
 * along its whole outline is something this can prove. A generated shape
 * that is merely probably inside would violate rule 1.
 *
 * The cost of that choice is measurable, and is the main reason a zone
 * falls short of its target FAR. Zone 1 plans 1,615% and reaches 1,386%
 * with two masses and no green space: at 36 storeys the plan needs
 * 4,719 m² of footprint, and the largest 1.6:1 rectangle that fits inside
 * this concave block's 9,138 m² buildable area is 3,381 m². The real
 * scheme achieves it with a footprint that follows the block outline.
 * Closing that gap means non-rectangular masses - an L or a shape offset
 * from the boundary - which needs a real polygon offset, not this.
 */
function fitRect(ring, cx, cy, targetArea, aspect, inset) {
  const w0 = Math.sqrt(targetArea * aspect);
  const h0 = targetArea / w0;
  // Shrink until the whole outline clears the setback; 40 steps at 0.92
  // reaches 3% of the target, far past anything worth placing.
  let scale = 1;
  for (let i = 0; i < 40; i++) {
    const w = (w0 * scale) / 2;
    const h = (h0 * scale) / 2;
    const corners = [
      [cx - w, cy - h],
      [cx + w, cy - h],
      [cx + w, cy + h],
      [cx - w, cy + h],
    ];
    // Corners alone can pass while an edge bulges across a concave
    // boundary, so sample along the edges too. Every sample must clear
    // the setback, not merely be inside the zone.
    let ok = true;
    outer: for (let e = 0; e < 4; e++) {
      const [ax, ay] = corners[e];
      const [bx, by] = corners[(e + 1) % 4];
      for (let s = 0; s < 12; s++) {
        const t = s / 12;
        if (!isInsetPoint(ax + (bx - ax) * t, ay + (by - ay) * t, ring, inset)) {
          ok = false;
          break outer;
        }
      }
    }
    if (ok) {
      return { ring: [...corners, corners[0]], area: w * 2 * (h * 2), scale };
    }
    scale *= 0.92;
  }
  return null;
}

/** Do two axis-aligned rectangles come within `gap` metres of each other? */
function rectsClash(a, b, gap) {
  return !(
    a.maxX + gap <= b.minX ||
    b.maxX + gap <= a.minX ||
    a.maxY + gap <= b.minY ||
    b.maxY + gap <= a.minY
  );
}

/**
 * Place one mass of `targetArea`, avoiding the ones already placed.
 *
 * Each mass searches for its own position rather than taking a slot on a
 * fixed grid. A first version did spread them evenly along the block's
 * long axis, and measured badly on the real shapes: zone 1 narrows from
 * north to south, so the southern tower had to shrink from a target of
 * 2,360 m² to 270 m² to fit, and the zone reached 671% FAR against a
 * planned 1,615%. Searching lets each mass find width where the block
 * actually has it.
 *
 * The search walks candidate centres from the most interior outward -
 * deepest first, since depth is what allows a large footprint - and takes
 * the first that fits at full size. If none does, it keeps the position
 * that fitted the largest rectangle, so a cramped zone yields a smaller
 * building rather than nothing.
 *
 * An optional `anchor` ("N"/"S"/"E"/"W") re-sorts the candidates so the
 * search starts from that side of the zone, depth as tiebreak within a
 * grid row. A mirofish negotiation fixes WHERE height goes (low toward
 * 종묘, high toward 청계천), and without a side preference the tallest
 * mass lands wherever the block is deepest. The full-size-first /
 * best-area fallback is unchanged: an anchor with no room still reports
 * a shortfall instead of forcing the position.
 */
const ANCHOR_SCORE = {
  N: (c) => c.y,
  S: (c) => -c.y,
  E: (c) => c.x,
  W: (c) => -c.x,
};

function placeMass(ring, targetArea, aspect, inset, placed, gap, anchor) {
  const b = bounds(ring);
  const N = 34;

  const candidates = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x = b.minX + ((i + 0.5) / N) * (b.maxX - b.minX);
      const y = b.minY + ((j + 0.5) / N) * (b.maxY - b.minY);
      if (!inRing(x, y, ring)) continue;
      const depth = distanceToOutline(x, y, ring);
      if (depth < inset) continue;
      candidates.push({ x, y, depth });
    }
  }
  const score = ANCHOR_SCORE[anchor];
  candidates.sort(
    score
      ? (p, q) => score(q) - score(p) || q.depth - p.depth
      : (p, q) => q.depth - p.depth,
  );

  let best = null;
  for (const c of candidates) {
    const rect = fitRect(ring, c.x, c.y, targetArea, aspect, inset);
    if (!rect) continue;
    const rb = bounds(rect.ring);
    if (placed.some((p) => rectsClash(rb, p, gap))) continue;
    if (rect.scale >= 0.999) return { rect, box: rb };
    if (!best || rect.area > best.rect.area) best = { rect, box: rb };
  }
  return best;
}

// --- the generator ----------------------------------------------------

/**
 * Build the new massing for one zone.
 *
 * The config states FAR and storeys; the footprint is derived, because
 * that is the direction a plan is written in - "1,600% at 36 storeys" is
 * the language of the document, and floor area is what it fixes. Per
 * entry:
 *
 *   gross floor area = site area * far / 100
 *   footprint each   = gross floor area / (storeys * count)
 *
 * `green_ratio` is taken off the buildable area before anything is
 * placed, so the greened share is real rather than nominal.
 *
 * Returns the features plus a report: what was asked, what was achieved,
 * and every way the two differ. A mass that could not reach its target
 * footprint is reported as shortfall rather than being quietly dropped or
 * pushed past the boundary.
 */
export function generateMassing(zone, config) {
  const zoneType = zone.properties.zone_type;
  if (!isUpdatable(zoneType)) {
    return { features: [], report: { error: `zone type not updatable: ${zoneType}` } };
  }

  const outer = zone.geometry.coordinates[0];
  const frame = metresFrame(outer);
  const ringM = outer.map(frame.toM);
  const siteArea = ringArea(ringM);

  // The buildable region is "at least `inset` metres inside the outline",
  // never a constructed offset polygon - see isInsetPoint.
  const greenRatio = config.green_ratio ?? 0;
  const setback =
    greenRatio > 0
      ? insetForRatio(ringM, SETBACK_M, greenRatio)
      : SETBACK_M;
  const buildableArea = insetArea(ringM, setback);
  if (buildableArea <= 0) {
    return {
      features: [],
      report: {
        error:
          greenRatio > 0
            ? `green_ratio ${greenRatio} leaves no buildable area`
            : `zone too small for a ${SETBACK_M} m setback`,
      },
    };
  }
  const plot = ringM;

  const entries = config.buildings ?? [];
  const features = [];
  const massReports = [];
  const occupied = [];
  let seq = 0;

  for (const entry of entries) {
    const count = Math.max(1, entry.count ?? 1);
    const storeys = entry.floors ?? 1;
    const gfa = (siteArea * (entry.far ?? 0)) / 100;
    const targetFootprint = gfa / (storeys * count);

    for (let n = 0; n < count; n++) {
      const spot = placeMass(
        plot,
        targetFootprint,
        entry.aspect ?? 1.6,
        setback,
        occupied,
        MASS_GAP_M,
        entry.anchor,
      );
      if (!spot) {
        massReports.push({
          use: entry.use,
          storeys,
          targetFootprint: Math.round(targetFootprint),
          achievedFootprint: 0,
          placed: false,
        });
        continue;
      }
      const rect = spot.rect;
      occupied.push(spot.box);
      seq += 1;
      features.push({
        type: "Feature",
        id: `zu-${zone.id}-${seq}`,
        properties: {
          // NGII's own vocabulary, so 용도별 색상 recognises it.
          use: entry.use ?? "업무시설",
          floors: storeys,
          height_m: storeys * (entry.storey_height ?? STOREY_M),
          area_m2: Math.round(rect.area),
          zone_fid: zone.id,
          generated: true,
        },
        geometry: {
          type: "Polygon",
          coordinates: [rect.ring.map(frame.toLonLat)],
        },
      });
      massReports.push({
        use: entry.use,
        storeys,
        targetFootprint: Math.round(targetFootprint),
        achievedFootprint: Math.round(rect.area),
        placed: true,
      });
    }
  }

  const achievedGfa = features.reduce(
    (sum, f) => sum + f.properties.area_m2 * f.properties.floors,
    0,
  );

  return {
    features,
    report: {
      zone_fid: zone.id,
      zoneType,
      siteAreaM2: Math.round(siteArea),
      buildableAreaM2: Math.round(buildableArea),
      setbackM: +setback.toFixed(1),
      greenRatio,
      requested: entries.reduce((n, e) => n + Math.max(1, e.count ?? 1), 0),
      placed: features.length,
      targetFar: entries.reduce((sum, e) => sum + (e.far ?? 0), 0),
      achievedFar: +((achievedGfa / siteArea) * 100).toFixed(1),
      achievedGfaM2: Math.round(achievedGfa),
      masses: massReports,
    },
  };
}

/**
 * The setback that leaves `1 - ratio` of the zone buildable, so green
 * space becomes a real margin around the plot rather than a nominal
 * percentage.
 *
 * Bisection rather than a closed form: the area lost to an inset depends
 * on the perimeter and every corner angle, and for an arbitrary block
 * outline there is no neat expression. Never returns less than the
 * minimum setback - green space may push the buildings further in, never
 * closer to the boundary.
 */
function insetForRatio(ringM, minInset, ratio) {
  const target = ringArea(ringM) * (1 - ratio);
  let lo = minInset;
  let hi = 80;
  // 18 halvings of an 80 m interval is well under a millimetre, far past
  // the sampled area's own precision.
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (insetArea(ringM, mid, 60) > target) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Every generated vertex must be inside the zone. This is rule 1, checked
 * rather than trusted: the inset is a convex clip per edge and the fit is
 * a sampled test, so neither is a proof on its own. Returns the offending
 * points, so a failure can be looked at rather than just counted.
 */
export function verifyInsideZone(features, zone) {
  const outside = [];
  for (const f of features) {
    for (const ring of f.geometry.coordinates) {
      for (const [lon, lat] of ring) {
        if (!pointInPolygon(lon, lat, zone.geometry)) {
          outside.push({ id: f.id, lon, lat });
        }
      }
    }
  }
  return { ok: outside.length === 0, outsideCount: outside.length, outside };
}
