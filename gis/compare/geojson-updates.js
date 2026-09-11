// Immutable base features keep their identity across scenario compositions.
// Send only removed/replaced features to MapLibre's worker.
export function createGeoJSONUpdater(source, initial) {
  let previous = new Map(initial.features.map((feature) => [feature.id, feature]));
  return (collection) => {
    const next = new Map(collection.features.map((feature) => [feature.id, feature]));
    const remove = [...previous.keys()].filter((id) => !next.has(id));
    const add = collection.features.filter((feature) => previous.get(feature.id) !== feature);
    if (remove.length || add.length) source.updateData({ remove, add });
    previous = next;
  };
}
