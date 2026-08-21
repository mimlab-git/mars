function parentOrigin() {
  try {
    return new URL(document.referrer).origin;
  } catch {
    return "";
  }
}

/** Publish the building selected in either map to the shared detail panel. */
export function postComparisonBuilding(snapshot, building) {
  if (window.parent === window) return;
  window.parent.postMessage(
    { type: "mimlab:gis-building", snapshot, building },
    parentOrigin() || "*",
  );
}

/** Keep both snapshot cameras aligned without exposing viewer internals. */
export function startComparisonBridge(map, snapshot, options = {}) {
  if (window.parent === window) return;

  document.documentElement.classList.add("comparison-embed");

  const targetOrigin = parentOrigin();

  let applyingRemoteCamera = false;
  let applyingRemoteControl = false;
  let framePending = false;
  let scheduleStats = () => {};
  const syncedControls = ["swap", "show-zones"];

  function cameraState() {
    const center = map.getCenter();
    return {
      center: [center.lng, center.lat],
      zoom: map.getZoom(),
      pitch: map.getPitch(),
      bearing: map.getBearing(),
    };
  }

  function sendCamera() {
    framePending = false;
    if (applyingRemoteCamera) return;
    window.parent.postMessage(
      { type: "mimlab:gis-camera", snapshot, camera: cameraState() },
      targetOrigin || "*",
    );
  }

  map.on("move", () => {
    if (applyingRemoteCamera || framePending) return;
    framePending = true;
    requestAnimationFrame(sendCamera);
  });

  if (typeof options.getStats === "function") {
    const sendStats = () => {
      window.parent.postMessage(
        { type: "mimlab:gis-stats", snapshot, stats: options.getStats() },
        targetOrigin || "*",
      );
    };
    let statsTimer = null;
    scheduleStats = () => {
      clearTimeout(statsTimer);
      statsTimer = setTimeout(sendStats, 180);
    };
    sendStats();
    map.on("moveend", scheduleStats);
    map.on("idle", scheduleStats);
  }

  if (options.scenario) {
    window.parent.postMessage(
      { type: "mimlab:gis-scenario", snapshot, scenario: options.scenario },
      targetOrigin || "*",
    );
  }

  for (const id of syncedControls) {
    const control = document.getElementById(id);
    if (!control) continue;
    const eventName = control.type === "range" ? "input" : "change";
    control.addEventListener(eventName, () => {
      if (applyingRemoteControl) return;
      window.parent.postMessage(
        {
          type: "mimlab:gis-control",
          snapshot,
          control: {
            id,
            value: control.type === "checkbox" ? control.checked : control.value,
          },
        },
        targetOrigin || "*",
      );
      scheduleStats();
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    if (targetOrigin && event.origin !== targetOrigin) return;
    if (event.data?.type === "mimlab:gis-set-control") {
      const incoming = event.data.control;
      if (incoming?.id === "scenario") {
        options.setScenarioVisible?.(Boolean(incoming.value));
        scheduleStats();
        return;
      }
      if (!syncedControls.includes(incoming?.id)) return;
      const control = document.getElementById(incoming.id);
      if (!control) return;

      applyingRemoteControl = true;
      if (control.type === "checkbox" && typeof incoming.value === "boolean") {
        control.checked = incoming.value;
        control.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (control.type === "range" && Number.isFinite(Number(incoming.value))) {
        control.value = String(incoming.value);
        control.dispatchEvent(new Event("input", { bubbles: true }));
      }
      applyingRemoteControl = false;
      return;
    }

    if (event.data?.type !== "mimlab:gis-set-camera") return;

    const camera = event.data.camera;
    if (
      !Array.isArray(camera?.center) ||
      camera.center.length !== 2 ||
      !camera.center.every(Number.isFinite) ||
      ![camera.zoom, camera.pitch, camera.bearing].every(Number.isFinite)
    ) {
      return;
    }

    applyingRemoteCamera = true;
    map.jumpTo(camera);
    requestAnimationFrame(() => {
      applyingRemoteCamera = false;
    });
  });

  window.parent.postMessage(
    { type: "mimlab:gis-ready", snapshot, camera: cameraState() },
    targetOrigin || "*",
  );
}
