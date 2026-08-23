// One-context BEFORE/AFTER curtain for MapLibre.
//
// Custom layers change WebGL's scissor rectangle for the translucent site
// layers that follow them. Basemap, terrain, labels, and OSM render once.

const LEFT_CLIP = "comparison-clip-left";
const RIGHT_CLIP = "comparison-clip-right";
const RESET_CLIP = "comparison-clip-reset";

function clipLayer(id, apply) {
  return {
    id,
    type: "custom",
    renderingMode: "3d",
    render(gl) {
      apply(gl);
    },
    onRemove(_map, gl) {
      gl.disable(gl.SCISSOR_TEST);
    },
  };
}

/**
 * Place two fill-extrusion layers behind one draggable screen-space curtain.
 * Returns a setter accepting a percentage from 0 to 100.
 */
export function addComparisonCurtain(map, beforeLayer, afterLayer, beforeId) {
  let position = 50;
  const splitX = (gl) =>
    Math.round((Math.min(100, Math.max(0, position)) / 100) * gl.drawingBufferWidth);

  map.addLayer(
    clipLayer(LEFT_CLIP, (gl) => {
      const split = splitX(gl);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, 0, split, gl.drawingBufferHeight);
    }),
    beforeLayer,
  );

  map.addLayer(
    clipLayer(RIGHT_CLIP, (gl) => {
      const split = splitX(gl);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(split, 0, gl.drawingBufferWidth - split, gl.drawingBufferHeight);
    }),
    afterLayer,
  );

  map.addLayer(
    clipLayer(RESET_CLIP, (gl) => {
      gl.disable(gl.SCISSOR_TEST);
    }),
    beforeId,
  );

  return (next) => {
    if (!Number.isFinite(Number(next))) return position;
    position = Math.min(100, Math.max(0, Number(next)));
    map.triggerRepaint();
    return position;
  };
}
