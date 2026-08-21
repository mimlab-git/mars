// Entry point: wire the modules together, drive the UI, expose __viewer.

import { AREA, COLORS } from "./config.js";
import {
  postComparisonBuilding,
  startComparisonBridge,
} from "./comparison.js?v=trackb-panels-v1";
import { createMap, loadViews, waitIdle } from "./map.js";
import {
  OSM_OUTSIDE_LAYER,
  OSM_STRADDLE_LAYER,
  addOSMOutsideLayer,
  insideIdCount,
  isSwapEnabled,
  refreshInsideIds,
  setSwapEnabled,
} from "./swap.js";
import { Buildings, NGII_LAYER, NGII_LAYERS } from "./buildings.js";
import { ZONE_FILL_LAYER, Zones } from "./zones.js";
import { generateMassing, isUpdatable, verifyInsideZone } from "./zoneupdate.js";

const $ = (id) => document.getElementById(id);
const status = (text) => {
  $("status").textContent = text;
};

const map = await createMap("map");
const buildings = new Buildings(map);
const zones = new Zones(map);
let useLegend = [];

function summarizeSiteUses() {
  const counts = new Map();
  for (const feature of buildings.data?.features ?? []) {
    if (feature.properties.zone_fid == null) continue;
    const use = feature.properties.use || "(없음)";
    counts.set(use, (counts.get(use) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([use, count]) => ({
      use,
      count,
      color: COLORS.byUse[use] ?? COLORS.byUse._other,
    }));
}

// The style's first label layer. Buildings must be inserted below it so
// street names stay readable on top of the extrusions.
const firstSymbol = map
  .getStyle()
  .layers.find((l) => l.type === "symbol")?.id;

status("건물 불러오는 중...");
let loaded = 0;
let zoneTagged = 0;
try {
  const zoneCount = await zones.load();
  loaded = await buildings.load(zones.bounds());
  const swapReady = addOSMOutsideLayer(map, firstSymbol);
  buildings.addLayer(firstSymbol);
  zones.addLayers(NGII_LAYER);
  const tagged = zones.tagBuildings(buildings.data.features);
  zoneTagged = tagged.tagged;
  useLegend = summarizeSiteUses();
  buildings.refresh();
  zones.addHighlightLayer(firstSymbol);
  setSwapEnabled(map, true);
  status(
    swapReady
      ? `NGII 건물 ${loaded.toLocaleString()}동 · 구역 ${zoneCount}개`
      : `NGII 건물 ${loaded.toLocaleString()}동 (구역 외 OSM 레이어 실패)`,
  );
} catch (err) {
  status(`건물 로드 실패: ${err.message}`);
  console.error(err);
}

// --- controls ---------------------------------------------------------

$("swap").addEventListener("change", (e) => {
  setSwapEnabled(map, e.target.checked);
  buildings.setVisible(e.target.checked);
});

buildings.setColorByUse(true);

$("show-zones").addEventListener("change", (e) => {
  zones.setVisible(e.target.checked);
  if (!e.target.checked) showZone(null);
});

/** Render the selected zone's attributes, or clear the panel. */
function showZone(fid) {
  const buildingIds =
    fid === null || buildings.zoneUpdates.has(fid)
      ? []
      : buildings.originalIn(fid).map((f) => f.id);
  const p = zones.select(fid, buildingIds);
  const box = $("zone-info");
  if (!p) {
    box.innerHTML = "";
    return null;
  }
  // Most attributes are empty in the source (stage 0/48, zone_area 7/48),
  // so only show what this zone actually has.
  const rows = [`<b>${p.zone_nm || p.zone_type}</b>`];
  rows.push(`<span>fid ${p.fid} · 구역 ${p.zone_dtl || p.zone || "-"}</span>`);
  if (p.zone_nm) rows.push(`<span>${p.zone_type}</span>`);
  if (p.location) rows.push(`<span>${p.location}</span>`);
  box.innerHTML = rows.join("<br>");
  return p;
}

// --- zone update panel ------------------------------------------------
//
// The panel is the configuration table made editable. It appears only for
// the 28 zones whose interior may be rebuilt - the 존치관리 zones and the
// parks have nothing to configure, and offering them a form would imply
// otherwise.
//
// Configs live here keyed by fid, and that map is what export writes and
// import reads. It is deliberately the same shape the engine takes, so a
// file from mirofish can be dropped in without translation.

// From config.js, so a generated mass carries a use the colour table and
// the NGII data both recognise. Inventing labels here ("업무" instead of
// "업무시설") left every new building grey under 용도별 색상.
const USES = COLORS.buildableUses;
const DEFAULT_MASS = { use: "업무시설", far: 800, floors: 20, count: 2 };

/** fid -> config, the editable state behind the panel. */
const configs = new Map();

function configFor(fid) {
  if (!configs.has(fid)) {
    configs.set(fid, {
      zone_fid: fid,
      green_ratio: 0.15,
      buildings: [{ ...DEFAULT_MASS }],
    });
  }
  return configs.get(fid);
}

/** Show the panel for an updatable zone, or hide it for anything else. */
function showUpdatePanel(fid, props) {
  const panel = $("update-panel");
  if (fid === null || !props || !isUpdatable(props.zone_type)) {
    panel.classList.remove("open");
    return;
  }
  panel.classList.add("open");
  $("update-zone").textContent =
    `fid ${fid} · ${props.zone_type}` +
    (props.location ? ` · ${props.location}` : "");

  // The city's own figures for this zone, where the plan states them.
  // They are the benchmark a generated massing is judged against, so they
  // belong next to the inputs rather than buried in the data.
  const plan = $("update-plan");
  const far =
    props.zone_area && props.tt_area
      ? ((props.tt_area / props.zone_area) * 100).toFixed(0)
      : null;
  if (props.scale || far) {
    plan.style.display = "";
    plan.textContent =
      `계획: ${props.scale ?? "-"}` + (far ? ` · 용적률 ${far}%` : "");
  } else {
    plan.style.display = "none";
  }

  const config = configFor(fid);
  $("green-ratio").value = config.green_ratio;
  renderMasses(config);
  renderReport(fid);
}

function renderMasses(config) {
  const list = $("mass-list");
  list.innerHTML = "";
  config.buildings.forEach((mass, index) => {
    const box = document.createElement("div");
    box.className = "mass";
    box.innerHTML = `
      <div class="mass-head">
        <span>용도 ${index + 1}</span>
        <button type="button" data-remove="${index}" title="삭제">×</button>
      </div>
      <div class="field">
        <label>용도</label>
        <select data-field="use" data-index="${index}">
          ${USES.map(
            (u) =>
              `<option value="${u}"${u === mass.use ? " selected" : ""}>${u}</option>`,
          ).join("")}
        </select>
      </div>
      <div class="field">
        <label>용적률 %</label>
        <input type="number" min="0" step="10" value="${mass.far}"
               data-field="far" data-index="${index}" />
      </div>
      <div class="field">
        <label>층수</label>
        <input type="number" min="1" max="120" step="1" value="${mass.floors}"
               data-field="floors" data-index="${index}" />
      </div>
      <div class="field">
        <label>동 수</label>
        <input type="number" min="1" max="12" step="1" value="${mass.count}"
               data-field="count" data-index="${index}" />
      </div>`;
    list.append(box);
  });
  // One button is disabled rather than hidden: a zone always needs at
  // least one use, and hiding the control would look like a bug.
  list.querySelectorAll("[data-remove]").forEach((b) => {
    b.disabled = config.buildings.length <= 1;
    b.style.visibility = config.buildings.length <= 1 ? "hidden" : "";
  });
}

/** Report the last apply: what was asked, what was achieved, and the
 *  boundary check, which is the one that must never fail. */
function renderReport(fid) {
  const box = $("update-report");
  const report = lastReports.get(fid);
  if (!report) {
    box.innerHTML = buildings.zoneUpdates.has(fid)
      ? "적용됨"
      : "<span style='color:#999'>미적용</span>";
    return;
  }
  if (report.error) {
    box.innerHTML = `<span class="bad">${report.error}</span>`;
    return;
  }
  const violated = report.boundary.outsideCount > 0;
  box.innerHTML = [
    `대지 ${report.siteAreaM2.toLocaleString()} m2`,
    `가용 ${report.buildableAreaM2.toLocaleString()} m2 (이격 ${report.setbackM} m)`,
    `동수 ${report.placed}/${report.requested}`,
    `용적률 ${report.achievedFar}% / 목표 ${report.targetFar}%`,
    `철거 ${report.demolished}동`,
    violated
      ? `<span class="bad">구역 이탈 ${report.boundary.outsideCount}</span>`
      : `<span class="good">구역 이탈 0</span>`,
  ].join("\n");
}

/** fid -> the report from its last apply, for the panel to display. */
const lastReports = new Map();

$("mass-list")?.addEventListener("input", (e) => {
  const fid = zones.selected;
  if (fid === null) return;
  const { field, index } = e.target.dataset;
  if (!field) return;
  const mass = configFor(fid).buildings[Number(index)];
  mass[field] = field === "use" ? e.target.value : Number(e.target.value);
});

$("mass-list")?.addEventListener("click", (e) => {
  const remove = e.target.dataset.remove;
  if (remove === undefined) return;
  const config = configFor(zones.selected);
  config.buildings.splice(Number(remove), 1);
  renderMasses(config);
});

$("add-mass")?.addEventListener("click", () => {
  const config = configFor(zones.selected);
  config.buildings.push({ ...DEFAULT_MASS, use: "상업", far: 300, floors: 5 });
  renderMasses(config);
});

$("green-ratio")?.addEventListener("input", (e) => {
  if (zones.selected === null) return;
  configFor(zones.selected).green_ratio = Number(e.target.value);
});

$("apply-update")?.addEventListener("click", () => {
  const fid = zones.selected;
  if (fid === null) return;
  const report = viewer.applyZoneUpdate(configFor(fid));
  lastReports.set(fid, report);
  renderReport(fid);
});

$("reset-update")?.addEventListener("click", () => {
  const fid = zones.selected;
  if (fid === null) return;
  viewer.resetZone(fid);
  lastReports.delete(fid);
  renderReport(fid);
});

// --- configuration table I/O ------------------------------------------
//
// Export/import IS the persistence story. The DB is read-only, so an
// update has nowhere to be written; a JSON file makes a run reproducible
// and reviewable without adding the project's first writable dependency.

$("export-config")?.addEventListener("click", () => {
  const blob = new Blob([viewer.exportConfig()], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "zone_config.json";
  a.click();
  URL.revokeObjectURL(url);
});

$("import-config")?.addEventListener("click", () => $("import-file")?.click());

$("import-file")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const result = viewer.importConfig(await file.text());
    status(`설정 불러옴: 구역 ${result.applied.length}개 적용`);
  } catch (err) {
    status(`불러오기 실패: ${err.message}`);
  }
  // Clear, so re-picking the same file fires `change` again.
  e.target.value = "";
});

// --- debug panel ------------------------------------------------------
//
// Plain HTML on purpose. The WebGL canvas is opaque to accessibility
// snapshots, so this text is how Playwright sees the map's state.

const debug = $("debug-panel");
let frames = 0;
let fps = 0;
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

const stats = () => {
  const c = map.getCenter();
  return {
    lon: +c.lng.toFixed(5),
    lat: +c.lat.toFixed(5),
    zoom: +map.getZoom().toFixed(2),
    pitch: Math.round(map.getPitch()),
    bearing: Math.round(map.getBearing()),
    fps,
    ngiiLoaded: buildings.count(),
    ngiiDrawn: buildings.drawnCount(),
    ngiiOutsideArea: buildings.outsideArea,
    floorHeight: buildings.floorHeight,
    swap: isSwapEnabled(map),
    osmMasked: insideIdCount(),
    zonesLoaded: zones.count(),
    zonesDrawn: zones.drawnCount(),
    zoneSelected: zones.selected,
    zoneTagged,
    zoneHighlightDrawn: zones.highlightDrawnCount(),
    useLegend,
    idle: map.loaded() && map.areTilesLoaded(),
  };
};

const renderDebug = () => {
  const s = stats();
  debug.textContent = [
    `lon/lat  ${s.lon}, ${s.lat}`,
    `zoom     ${s.zoom}   pitch ${s.pitch}   bearing ${s.bearing}`,
    `fps      ${s.fps}`,
    `NGII     ${s.ngiiLoaded.toLocaleString()} loaded / ${s.ngiiDrawn.toLocaleString()} drawn (${s.ngiiOutsideArea.toLocaleString()} outside area)`,
    `floor    ${s.floorHeight.toFixed(1)} m`,
    `swap     ${s.swap ? "on" : "off"}   OSM masked ${s.osmMasked.toLocaleString()}`,
    `zones    ${s.zonesLoaded} loaded / ${s.zonesDrawn} drawn / ${s.zoneTagged.toLocaleString()} bldgs tagged` +
      (s.zoneSelected === null
        ? ""
        : `\n         selected fid ${s.zoneSelected}   highlight ${s.zoneHighlightDrawn} drawn`),
  ].join("\n");
};
if (window.parent === window) {
  let debugTimer = null;
  const scheduleDebug = () => {
    clearTimeout(debugTimer);
    debugTimer = setTimeout(renderDebug, 180);
  };
  renderDebug();
  map.on("moveend", scheduleDebug);
  map.on("idle", scheduleDebug);
}

// --- click inspection -------------------------------------------------

map.on("click", (e) => {
  // Zone selection tracks every click, including clicks on a building -
  // the building sits in the zone, so both facts are wanted at once.
  const [zoneHit] = map.getLayer(ZONE_FILL_LAYER)
    ? map.queryRenderedFeatures(e.point, { layers: [ZONE_FILL_LAYER] })
    : [];
  showZone(zoneHit ? zoneHit.id : null);

  const [hit] = map.queryRenderedFeatures(e.point, {
    layers: [...NGII_LAYERS, OSM_OUTSIDE_LAYER, OSM_STRADDLE_LAYER].filter(
      (id) => map.getLayer(id),
    ),
  });
  if (!hit) {
    postComparisonBuilding("before", null);
    return;
  }

  const p = hit.properties;
  postComparisonBuilding("before", {
    id: hit.id ?? null,
    dataset: NGII_LAYERS.includes(hit.layer.id) ? "NGII" : "OSM",
    ...p,
  });
});

for (const layer of NGII_LAYERS) {
  map.on("mouseenter", layer, () => {
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", layer, () => {
    map.getCanvas().style.cursor = "";
  });
}

// --- test bridge ------------------------------------------------------
//
// Required by the project rules: every interactive feature above must be
// reachable from here, because this is the only handle Playwright has.

const views = await loadViews();

// Named, because the update panel above calls back into these methods -
// the UI drives exactly the same entry points Playwright does, so there is
// no path a test cannot reach.
const viewer = {
  map,
  buildings,
  views,
  area: AREA,
  getStats: stats,
  waitIdle: (ms) => waitIdle(map, ms),
  flyTo(view) {
    const target = typeof view === "string" ? views[view] : view;
    if (!target) throw new Error(`unknown view: ${view}`);
    map.jumpTo({
      center: [target.lon ?? target.center[0], target.lat ?? target.center[1]],
      zoom: target.zoom,
      pitch: target.pitch ?? 0,
      bearing: target.bearing ?? target.heading ?? 0,
    });
    return waitIdle(map);
  },
  setLayerVisible(name, visible) {
    if (name === "ngii") buildings.setVisible(visible);
    else if (map.getLayer(name)) {
      map.setLayoutProperty(name, "visibility", visible ? "visible" : "none");
    } else return false;
    return true;
  },
  setSwap(enabled) {
    $("swap").checked = enabled;
    setSwapEnabled(map, enabled);
    buildings.setVisible(enabled);
    return enabled;
  },
  refreshMask: () => refreshInsideIds(map),
  maskedCount: insideIdCount,
  setFloorHeight(m) {
    return buildings.setFloorHeight(Number(m));
  },
  setColorByUse(enabled) {
    return buildings.setColorByUse(enabled);
  },
  zones,
  setZonesVisible(visible) {
    $("show-zones").checked = visible;
    zones.setVisible(visible);
    if (!visible) showZone(null);
    return visible;
  },
  /** Highlight a zone by fid (null clears). Returns its attributes. */
  selectZone: showZone,
  /** Attributes of one zone without selecting it. */
  zoneInfo: (fid) => zones.get(fid),
  /** Zone fids actually drawn on screen. */
  zonesDrawn: () => zones.drawnCount(),
  /**
   * Buildings assigned to a zone, by gid. This is the link every zone
   * update operates through: a config names a zone, and these are the
   * buildings it may touch.
   */
  zoneBuildings: (fid) =>
    buildings.data ? zones.buildingsIn(fid, buildings.data.features) : [],
  /** Highlighted buildings actually DRAWN, not the number requested. */
  zoneHighlightDrawn: () => zones.highlightDrawnCount(),
  /**
   * Apply a zone update: demolish everything in the zone and build the
   * config's massing in its place.
   *
   *   __viewer.applyZoneUpdate({
   *     zone_fid: 1, green_ratio: 0.2,
   *     buildings: [{ use: "업무", far: 1200, floors: 36, count: 2 }],
   *   })
   *
   * Returns the generator's report plus the boundary check. Nothing is
   * applied if any generated vertex falls outside the zone - the rule is
   * that a mass may not leave its zone, so a violation fails loudly
   * instead of being clipped into something that looks fine.
   */
  applyZoneUpdate(config, refresh = true) {
    const fid = config.zone_fid;
    const zone = zones.data?.features.find((f) => f.id === fid);
    if (!zone) return { error: `no zone with fid ${fid}` };

    const { features, report } = generateMassing(zone, config);
    if (report.error) return report;

    const check = verifyInsideZone(features, zone);
    if (!check.ok) {
      return { ...report, applied: false, boundary: check };
    }
    const demolished = buildings.originalIn(fid).length;
    buildings.setZoneUpdate(fid, features, refresh);
    return { ...report, applied: true, demolished, boundary: check };
  },
  /** Remove a zone's update (null clears every one). */
  resetZone(fid = null, refresh = true) {
    buildings.clearZoneUpdate(fid, refresh);
    return { cleared: fid === null ? "all" : fid };
  },
  /** Zones with an update in force, and how many masses each holds. */
  zoneUpdates: () =>
    Object.fromEntries(
      [...buildings.zoneUpdates].map(([fid, u]) => [fid, u.features.length]),
    ),
  /** Zone types this project will rebuild the interior of (28 of 48). */
  updatableZones: () =>
    zones.data.features
      .filter((f) => isUpdatable(f.properties.zone_type))
      .map((f) => f.id),
  /**
   * How the tagging came out, for verification: how many buildings landed
   * in a zone, and the per-zone breakdown. `unassigned` is expected and
   * large - the load covers the whole sheet grid, the zones cover 0.39 km2
   * of it.
   */
  zoneTagStats() {
    const feats = buildings.data?.features ?? [];
    const perZone = new Map();
    for (const f of feats) {
      const fid = f.properties.zone_fid;
      if (fid !== null && fid !== undefined) {
        perZone.set(fid, (perZone.get(fid) ?? 0) + 1);
      }
    }
    const tagged = [...perZone.values()].reduce((sum, count) => sum + count, 0);
    return {
      total: buildings.count(),
      tagged,
      unassigned: buildings.count() - tagged,
      zonesWithBuildings: perZone.size,
      perZone: Object.fromEntries([...perZone].sort((a, b) => a[0] - b[0])),
    };
  },
  selectFeature(id) {
    const f = buildings.selectFeature(id);
    return f ? { id: f.id, ...f.properties } : null;
  },
  /**
   * Places on screen where BOTH datasets draw a building - the bug this
   * whole intersects rule exists to remove. Samples a grid rather than
   * testing geometry, because what matters is what is drawn, not what was
   * loaded. Returns the offending points so they can be flown to.
   */
  findOverlaps(step = 12) {
    const c = map.getCanvas();
    const layers = [...NGII_LAYERS, OSM_OUTSIDE_LAYER, OSM_STRADDLE_LAYER].filter(
      (id) => map.getLayer(id),
    );
    if (layers.length < 2) return { checked: 0, overlaps: [] };

    const overlaps = [];
    let checked = 0;
    for (let x = 0; x < c.clientWidth; x += step) {
      for (let y = 0; y < c.clientHeight; y += step) {
        checked += 1;
        const hits = map.queryRenderedFeatures([x, y], { layers });
        if (!hits.length) continue;
        const hasNgii = hits.some((h) => NGII_LAYERS.includes(h.layer.id));
        const hasOsm = hits.some((h) => !NGII_LAYERS.includes(h.layer.id));
        if (hasNgii && hasOsm) {
          const ll = map.unproject([x, y]);
          overlaps.push({ x, y, lon: +ll.lng.toFixed(6), lat: +ll.lat.toFixed(6) });
        }
      }
    }
    return { checked, overlaps, count: overlaps.length };
  },
  /** Which datasets draw at a point - the overlap check. */
  buildingsAt(lon, lat) {
    const pt = map.project([lon, lat]);
    const box = [
      [pt.x - 2, pt.y - 2],
      [pt.x + 2, pt.y + 2],
    ];
    const layers = [...NGII_LAYERS, OSM_OUTSIDE_LAYER, OSM_STRADDLE_LAYER].filter(
      (id) => map.getLayer(id),
    );
    const hits = map.queryRenderedFeatures(box, { layers });
    return {
      ngii: hits.filter((h) => NGII_LAYERS.includes(h.layer.id)).length,
      osm: hits.filter((h) => !NGII_LAYERS.includes(h.layer.id)).length,
    };
  },
  /**
   * The whole configuration table as JSON - every zone that has been
   * configured, whether or not its update is currently applied.
   *
   * This is the project's answer to "where do edits live". The DB is
   * read-only, so nothing can be written back; a config file instead makes
   * a run reproducible, reviewable and diffable, and is the same shape
   * mirofish will eventually emit.
   */
  exportConfig() {
    return JSON.stringify(
      {
        version: 1,
        zones: [...configs.values()],
        applied: [...buildings.zoneUpdates.keys()],
      },
      null,
      2,
    );
  },
  /**
   * Load a configuration table and apply the zones it marks as applied.
   * Replaces the current table rather than merging - a file describes a
   * whole scenario, and half of one is not a scenario.
   */
  importConfig(json) {
    const data = typeof json === "string" ? JSON.parse(json) : json;
    if (!Array.isArray(data?.zones)) throw new Error("zones[] missing");

    viewer.resetZone(null, false);
    configs.clear();
    lastReports.clear();
    for (const config of data.zones) {
      if (typeof config.zone_fid !== "number") continue;
      configs.set(config.zone_fid, config);
    }

    const applied = [];
    const failed = [];
    for (const fid of data.applied ?? []) {
      const config = configs.get(fid);
      if (!config) continue;
      const report = viewer.applyZoneUpdate(config, false);
      lastReports.set(fid, report);
      (report.error || !report.applied ? failed : applied).push(fid);
    }
    buildings.refresh();
    if (zones.selected !== null) showZone(zones.selected);
    return { zones: configs.size, applied, failed };
  },
  /** The editable configuration table, for tests to inspect directly. */
  configs,
};

window.__viewer = viewer;
startComparisonBridge(map, "before", { getStats: stats });
