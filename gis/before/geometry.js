// Planar geometry helpers shared by the zone, massing, and K-OSM masking
// code: ray-cast point-in-polygon and polygon/polygon overlap tests in
// lon/lat. Both accept GeoJSON Polygon or MultiPolygon geometries.
//
// `intersectsArea` checks three cases, and all three are needed. Checking
// only the first misses a building larger than the area, and checking only
// vertices misses a wall that crosses a corner without either endpoint
// landing inside:
//   1. any building vertex inside the area
//   2. any area vertex inside the building
//   3. any pair of edges crossing
// Called per rendered piece, and a piece is a clipped fragment of the real
// footprint. Clipping can only shrink a piece, so a piece that overlaps
// proves the whole feature overlaps.

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
