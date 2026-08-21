// Operational buildings stream as viewport-sized vector tiles. Only the
// small zone envelope stays as GeoJSON for deterministic scenario editing.

import { COLORS, DEFAULT_FLOOR_HEIGHT } from "./config.js";

export const NGII_LAYER = "ngii-3d";
export const NGII_GENERATED_LAYER = "ngii-generated-3d";
export const NGII_LAYERS = [NGII_LAYER, NGII_GENERATED_LAYER];

const NGII_SOURCE = "ngii";
const GENERATED_SOURCE = "ngii-generated";
const SOURCE_LAYER = "buildings";
const STATIC_DATA_BASE = globalThis.__MIMLAB_GIS_DATA_BASE__ ?? "";

function dataUrl(dynamicPath, staticPath) {
  return STATIC_DATA_BASE
    ? `${STATIC_DATA_BASE}${staticPath}`
    : `${location.origin}/api/${dynamicPath}`;
}

export class Buildings {
  constructor(map) {
    this.map = map;
    this.data = null;
    this.totalCount = 0;
    this.floorHeight = DEFAULT_FLOOR_HEIGHT;
    this.colorByUse = false;
    this.loading = false;
    this.outsideArea = 0;
    this.zoneUpdates = new Map();
  }

  async load(zoneBbox) {
    this.loading = true;
    try {
      const bbox = zoneBbox.join(",");
      const [metadataResponse, zonesResponse] = await Promise.all([
        fetch(dataUrl("buildings/metadata", "buildings/metadata.json")),
        fetch(dataUrl(`layers/buildings?bbox=${bbox}`, "layers/buildings.json")),
      ]);
      if (!metadataResponse.ok || !zonesResponse.ok) {
        const failed = metadataResponse.ok ? zonesResponse : metadataResponse;
        const detail = await failed.json().catch(() => ({}));
        throw new Error(detail.detail ?? `HTTP ${failed.status}`);
      }

      const metadata = await metadataResponse.json();
      this.data = await zonesResponse.json();
      this.totalCount = metadata.count;
      this.outsideArea = metadata.outside_aoi;

      this.map.addSource(NGII_SOURCE, {
        type: "vector",
        tiles: [dataUrl("buildings/tiles/{z}/{x}/{y}.mvt", "buildings/tiles/{z}/{x}/{y}.mvt")],
        minzoom: metadata.minzoom,
        maxzoom: metadata.maxzoom,
      });
      this.map.addSource(GENERATED_SOURCE, {
        type: "geojson",
        data: this._generatedData(),
      });
      return this.totalCount;
    } finally {
      this.loading = false;
    }
  }

  addLayer(beforeId) {
    if (this.map.getLayer(NGII_LAYER)) return;
    const paint = {
      "fill-extrusion-color": this._colorExpression(),
      "fill-extrusion-height": [
        "*",
        ["coalesce", ["get", "floors"], 1],
        this.floorHeight,
      ],
      "fill-extrusion-opacity": 1,
    };
    this.map.addLayer(
      {
        id: NGII_LAYER,
        type: "fill-extrusion",
        source: NGII_SOURCE,
        "source-layer": SOURCE_LAYER,
        filter: this._baseFilter(),
        paint,
      },
      beforeId,
    );
    this.map.addLayer(
      {
        id: NGII_GENERATED_LAYER,
        type: "fill-extrusion",
        source: GENERATED_SOURCE,
        paint,
      },
      beforeId,
    );
  }

  _baseFilter() {
    const replacedIds = [];
    for (const fid of this.zoneUpdates.keys()) {
      replacedIds.push(...this.originalIn(fid).map((f) => f.id));
    }
    return replacedIds.length
      ? ["!", ["in", ["id"], ["literal", replacedIds]]]
      : ["all"];
  }

  _colorExpression() {
    if (!this.colorByUse) return COLORS.ngii;
    const { _other, ...uses } = COLORS.byUse;
    return ["match", ["get", "use"], ...Object.entries(uses).flat(), _other];
  }

  _generatedData() {
    return {
      type: "FeatureCollection",
      features: [...this.zoneUpdates.values()].flatMap((u) => u.features),
    };
  }

  refresh() {
    if (this.map.getLayer(NGII_LAYER)) {
      this.map.setFilter(NGII_LAYER, this._baseFilter());
    }
    this.map.getSource(GENERATED_SOURCE)?.setData(this._generatedData());
  }

  setZoneUpdate(fid, features, refresh = true) {
    this.zoneUpdates.set(fid, { features });
    if (refresh) this.refresh();
  }

  clearZoneUpdate(fid = null, refresh = true) {
    if (fid === null) this.zoneUpdates.clear();
    else this.zoneUpdates.delete(fid);
    if (refresh) this.refresh();
  }

  originalIn(fid) {
    return this.data.features.filter((f) => f.properties.zone_fid === fid);
  }

  setFloorHeight(metres) {
    this.floorHeight = metres;
    for (const layer of NGII_LAYERS) {
      if (this.map.getLayer(layer)) {
        this.map.setPaintProperty(layer, "fill-extrusion-height", [
          "*",
          ["coalesce", ["get", "floors"], 1],
          metres,
        ]);
      }
    }
    return metres;
  }

  setColorByUse(enabled) {
    this.colorByUse = enabled;
    for (const layer of NGII_LAYERS) {
      if (this.map.getLayer(layer)) {
        this.map.setPaintProperty(
          layer,
          "fill-extrusion-color",
          this._colorExpression(),
        );
      }
    }
    return enabled;
  }

  setVisible(visible) {
    for (const layer of NGII_LAYERS) {
      if (this.map.getLayer(layer)) {
        this.map.setLayoutProperty(
          layer,
          "visibility",
          visible ? "visible" : "none",
        );
      }
    }
  }

  count() {
    return this.totalCount;
  }

  selectFeature(id) {
    const local = this.data?.features.find((f) => String(f.id) === String(id));
    if (local) return local;
    const feature = this.map
      .querySourceFeatures(NGII_SOURCE, { sourceLayer: SOURCE_LAYER })
      .find((f) => String(f.id) === String(id));
    return feature ?? null;
  }

  drawnCount() {
    const c = this.map.getCanvas();
    const layers = NGII_LAYERS.filter((id) => this.map.getLayer(id));
    if (!layers.length) return 0;
    return this.map.queryRenderedFeatures(
      [
        [0, 0],
        [c.clientWidth, c.clientHeight],
      ],
      { layers },
    ).length;
  }
}
