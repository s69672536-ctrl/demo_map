// app.js
// Puthusu Collector — dashboard-style live route view.

const GEOFENCE_METERS = 45;
const PING_INTERVAL_MS = 15000;
const REFRESH_INTERVAL_MS = 10000;

let currentCollector = null;
let currentRoute = null;
let currentLeg = null;
let routeGeometry = null;
let routeGeometryRouteId = null;   // stores the route_id for which we've attempted geometry (success or failure)
let usingLocalLeg = false;

let watchId = null;
let myLastPosition = null;
let lastPingTime = 0;
let speedKmh = 0;
let lastPos = null;
let lastPosTime = null;
let hasShownArrivedFor = null;
let cardDismissedFor = null;

let map, routeLayerGroup, collectorMarker, stopMarkers = [];

function $id(id) { return document.getElementById(id); }

function formatCurrency(n) {
  return `₹${Math.round(n || 0).toLocaleString("en-IN")}`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

function showScreen(id) {
  $id("loginScreen").style.display = id === "login" ? "flex" : "none";
  $id("routeScreen").style.display = id === "route" ? "flex" : "none";
}

// ---------------- API helper ----------------
async function api(path, options = {}) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || `Request failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

// ---------------- Distance / geometry helpers ----------------
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function distanceKm(lat1, lng1, lat2, lng2) {
  return distanceMeters(lat1, lng1, lat2, lng2) / 1000;
}

function validStops() {
  if (!currentRoute || !currentRoute.stops) return [];
  return currentRoute.stops
    .filter((s) => s.latitude != null && s.longitude != null && !Number.isNaN(s.latitude) && !Number.isNaN(s.longitude))
    .slice()
    .sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
}

function totalRouteDistanceKm(stops) {
  let d = 0;
  for (let i = 1; i < stops.length; i++) {
    d += distanceKm(stops[i - 1].latitude, stops[i - 1].longitude, stops[i].latitude, stops[i].longitude);
  }
  return d;
}

function firstPendingIndex(stops) {
  return stops.findIndex((s) => s.status === "pending");
}

function remainingDistanceKm(stops) {
  const idx = firstPendingIndex(stops);
  if (idx === -1) return 0;
  let d = 0;
  if (myLastPosition) {
    d += distanceKm(myLastPosition.lat, myLastPosition.lng, stops[idx].latitude, stops[idx].longitude);
  } else if (idx > 0) {
    d += distanceKm(stops[idx - 1].latitude, stops[idx - 1].longitude, stops[idx].latitude, stops[idx].longitude);
  }
  for (let i = idx; i < stops.length - 1; i++) {
    d += distanceKm(stops[i].latitude, stops[i].longitude, stops[i + 1].latitude, stops[i + 1].longitude);
  }
  return d;
}

function estimateMinutes(km) {
  if (!speedKmh || speedKmh <= 0) return null;
  return (km / speedKmh) * 60;
}

// ---------------- Map ----------------
function initMap() {
  if (map) return;
  map = L.map("navMap", { zoomControl: false }).setView([13.0850, 80.2200], 12);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap &copy; CARTO",
    subdomains: "abcd",
    maxZoom: 20,
  }).addTo(map);
  L.control.zoom({ position: "topleft" }).addTo(map);
}

function numberedIcon(number, color) {
  return L.divIcon({
    className: "",
    html: `<div style="width:28px;height:28px;border-radius:50%;background:${color};color:#fff;
            display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;
            box-shadow:0 3px 10px rgba(0,0,0,0.35);border:2px solid #12172A;">${number}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function collectorIcon() {
  return L.divIcon({
    className: "",
    html: `<div style="width:34px;height:34px;border-radius:50%;background:rgba(59,130,246,0.25);
            display:flex;align-items:center;justify-content:center;border:2px solid #3B82F6;">
            <div style="width:16px;height:16px;border-radius:50%;background:#3B82F6;border:2px solid #fff;"></div>
           </div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

function stopColor(status) {
  if (status === "collected") return "#22C55E";
  if (status === "skipped" || status === "absent") return "#F59E0B";
  return "#1F2937";
}

function updateCollectorMarker() {
  if (!map || !myLastPosition) return;
  if (collectorMarker) {
    collectorMarker.setLatLng([myLastPosition.lat, myLastPosition.lng]);
  } else {
    collectorMarker = L.marker([myLastPosition.lat, myLastPosition.lng], { icon: collectorIcon(), zIndexOffset: 1000 })
      .addTo(map);
  }
}

function clearMapLayers() {
  stopMarkers.forEach((m) => map.removeLayer(m));
  stopMarkers = [];
  if (routeLayerGroup) { map.removeLayer(routeLayerGroup); routeLayerGroup = null; }
}

function drawRoute() {
  if (!map) return;
  clearMapLayers();

  const stops = validStops();
  if (!stops.length) return;

  const currentStopId = currentLeg && !currentLeg.route_completed ? currentLeg.to_customer_id : null;

  stops.forEach((s, idx) => {
    const isCurrent = s.customer_id === currentStopId;
    const color = isCurrent ? "#3B82F6" : stopColor(s.status);
    const marker = L.marker([s.latitude, s.longitude], { icon: numberedIcon(idx + 1, color) })
      .addTo(map)
      .bindPopup(`<b>${escapeHtml(s.name)}</b><br>${formatCurrency(s.default_amount)}`);
    stopMarkers.push(marker);
  });

  const group = L.layerGroup();
  const idx = firstPendingIndex(stops);

  if (routeGeometry && routeGeometry.length > 1) {
    group.addLayer(L.polyline(routeGeometry, { color: "#1F2937", weight: 3, opacity: 0.7, dashArray: "8 7" }));
  } else {
    for (let i = 0; i < stops.length - 1; i++) {
      const seg = [
        [stops[i].latitude, stops[i].longitude],
        [stops[i + 1].latitude, stops[i + 1].longitude]
      ];
      group.addLayer(L.polyline(seg, { color: "#1F2937", weight: 3, opacity: 0.75, dashArray: "8 7" }));
    }
  }

  const handledEnd = idx === -1 ? stops.length - 1 : idx;
  for (let i = 0; i < handledEnd; i++) {
    const seg = [
      [stops[i].latitude, stops[i].longitude],
      [stops[i + 1].latitude, stops[i + 1].longitude]
    ];
    const color = stops[i + 1].status === "collected" ? "#22C55E" : "#F59E0B";
    group.addLayer(L.polyline(seg, { color, weight: 4, opacity: 0.9 }));
  }

  if (idx !== -1) {
    if (currentLeg && currentLeg.geometry && currentLeg.geometry.length > 1) {
      group.addLayer(L.polyline(currentLeg.geometry, { color: "#3B82F6", weight: 5, opacity: 0.9, dashArray: "10 8" }));
    } else {
      const from = myLastPosition ?
        [myLastPosition.lat, myLastPosition.lng] :
        idx > 0 ? [stops[idx - 1].latitude, stops[idx - 1].longitude] : null;
      if (from) {
        const to = [stops[idx].latitude, stops[idx].longitude];
        group.addLayer(L.polyline([from, to], { color: "#3B82F6", weight: 5, opacity: 0.9, dashArray: "10 8" }));
      }
    }
  }

  routeLayerGroup = group;
  map.addLayer(group);

  const bounds = stops.map((s) => [s.latitude, s.longitude]);
  if (myLastPosition) bounds.push([myLastPosition.lat, myLastPosition.lng]);
  if (bounds.length > 1) map.fitBounds(L.latLngBounds(bounds), { padding: [60, 60] });
  else map.setView(bounds[0], 15);

  updateCollectorMarker();
}

// ---------------- GPS ----------------
function startGpsTracking() {
  if (!navigator.geolocation) {
    setLiveBadge(false, "No GPS");
    return;
  }
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const lat = pos.coords.latitude,
        lng = pos.coords.longitude;
      const now = Date.now();
      myLastPosition = { lat, lng };
      setLiveBadge(true, "Live");

      if (lastPos && lastPosTime) {
        const dtHours = (now - lastPosTime) / 1000 / 3600;
        if (dtHours > 0) {
          const distKm = distanceKm(lastPos.lat, lastPos.lng, lat, lng);
          speedKmh = distKm / dtHours;
        }
      }
      lastPos = { lat, lng };
      lastPosTime = now;

      checkGeofence();
      updateCollectorMarker();
      renderCurrentStopCard();
      updateStats();

      if (now - lastPingTime > PING_INTERVAL_MS && currentCollector) {
        lastPingTime = now;
        api(`/tracking/${currentCollector.id}/ping`, {
          method: "POST",
          body: JSON.stringify({ latitude: lat, longitude: lng }),
        }).catch(() => {});
      }
    },
    () => setLiveBadge(false, "Location off"),
    { enableHighAccuracy: true, maximumAge: 5000 }
  );
}

function stopGpsTracking() {
  if (watchId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

function checkGeofence() {
  if (!myLastPosition || !currentLeg || currentLeg.route_completed || !currentLeg.to_point) return;
  const d = distanceMeters(myLastPosition.lat, myLastPosition.lng, currentLeg.to_point.latitude, currentLeg.to_point
    .longitude);
  if (d <= GEOFENCE_METERS) {
    if (hasShownArrivedFor !== currentLeg.to_customer_id) {
      hasShownArrivedFor = currentLeg.to_customer_id;
      renderStops();
      renderCurrentStopCard();
    }
  }
}

// ---------------- Battery ----------------
function setupBattery() {
  if (!navigator.getBattery) { $id("batteryPercent").textContent = "—"; return; }
  navigator.getBattery().then((battery) => {
    const update = () => {
      const pct = Math.round(battery.level * 100);
      $id("batteryPercent").textContent = `${pct}%`;
      const icon = $id("batteryIcon");
      icon.className = `fas ${pct <= 20 ? "fa-battery-quarter" : pct <= 60 ? "fa-battery-half" : "fa-battery-full"}`;
      icon.classList.toggle("low", pct <= 20 && !battery.charging);
    };
    update();
    battery.addEventListener("levelchange", update);
    battery.addEventListener("chargingchange", update);
  }).catch(() => { $id("batteryPercent").textContent = "—"; });
}

// ---------------- Clock ----------------
function tickClock() {
  $id("currentTime").textContent = new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

// ---------------- Live badge ----------------
function setLiveBadge(live, text) {
  const badge = $id("liveBadge");
  badge.classList.toggle("offline", !live);
  $id("liveBadgeText").textContent = text;
}

// ---------------- Login ----------------
function normalizePhone(raw) {
  let digits = (raw || "").replace(/\D/g, "");
  if (digits.length > 10 && digits.startsWith("0")) digits = digits.replace(/^0+/, "");
  if (digits.length > 10 && digits.startsWith("91")) digits = digits.slice(-10);
  return digits;
}

async function handleLogin() {
  const rawPhone = $id("phoneInput").value.trim();
  const phone = normalizePhone(rawPhone);
  const errorEl = $id("loginError");
  errorEl.textContent = "";
  if (!phone) { errorEl.textContent = "Enter your phone number."; return; }

  const btn = $id("loginBtn");
  btn.disabled = true;
  btn.textContent = "Logging in...";
  try {
   const collector = await api(`/collectors/login?phone=${encodeURIComponent(phone)}`, {
     method: "POST",
   });
    currentCollector = collector;
    localStorage.setItem("collector", JSON.stringify(collector));
    startSession();
  } catch (e) {
    if (e instanceof TypeError) {
      errorEl.textContent = `Can't reach the server at ${API_BASE_URL}. Check your network and config.js.`;
    } else if (/no active collector/i.test(e.message)) {
      errorEl.textContent = "No active collector found with that phone number. Check with your manager.";
    } else {
      errorEl.textContent = `Couldn't log in: ${e.message}`;
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "Start My Day";
  }
}

function startSession() {
  showScreen("route");
  $id("collectorName").textContent = currentCollector.name || "Collector";
  $id("collectorAvatar").textContent = (currentCollector.name || "?").split(" ").map((w) => w[0]).join("").slice(0, 2)
    .toUpperCase();
  initMap();
  setupBattery();
  tickClock();
  setInterval(tickClock, 1000);
  startGpsTracking();
  refreshAll();
  setInterval(refreshAll, REFRESH_INTERVAL_MS);
}

function handleLogout() {
  stopGpsTracking();
  currentCollector = null;
  currentRoute = null;
  currentLeg = null;
  routeGeometry = null;
  routeGeometryRouteId = null;
  usingLocalLeg = false;
  myLastPosition = null;
  lastPos = null;
  lastPosTime = null;
  speedKmh = 0;
  hasShownArrivedFor = null;
  cardDismissedFor = null;
  if (map) {
    clearMapLayers();
    if (collectorMarker) { map.removeLayer(collectorMarker); collectorMarker = null; }
  }
  localStorage.removeItem("collector");
  $id("phoneInput").value = "";
  showScreen("login");
  window.scrollTo(0, 0);
}

// ---------------- Data loading ----------------
async function refreshAll() {
  if (!currentCollector) return;
  try {
    await loadTodayRoute();
    await loadCurrentLeg();
    await loadRouteGeometry();
  } catch (e) {
    console.error(e);
  }
  renderStops();
  renderCurrentStopCard();
  updateStats();
  drawRoute();
}

async function loadTodayRoute() {
  try {
    currentRoute = await api(`/collections/today?collector_id=${currentCollector.id}`);
  } catch (e) {
    currentRoute = null;
  }
}

async function loadCurrentLeg() {
  try {
    currentLeg = await api(`/collections/current-leg?collector_id=${currentCollector.id}`);
    usingLocalLeg = false;
  } catch (e) {
    currentLeg = deriveLocalLeg();
    usingLocalLeg = true;
  }
}

function deriveLocalLeg() {
  const stops = validStops();
  const idx = firstPendingIndex(stops);
  if (idx === -1) return { route_completed: true };
  const stop = stops[idx];
  const from = myLastPosition || (idx > 0 ? { lat: stops[idx - 1].latitude, lng: stops[idx - 1].longitude } : null);
  const distance_km = from ? distanceKm(from.lat, from.lng, stop.latitude, stop.longitude) : null;
  const eta = distance_km != null ? estimateMinutes(distance_km) : null;
  return {
    route_completed: false,
    to_customer_id: stop.customer_id,
    to_point: { latitude: stop.latitude, longitude: stop.longitude, label: stop.name, phone: stop.phone,
      address: stop.address },
    distance_km: distance_km != null ? Math.round(distance_km * 10) / 10 : null,
    eta_minutes: eta,
  };
}

// ✅ FIXED: prevent repeated geometry calls for routes with no customers
async function loadRouteGeometry() {
  if (!currentRoute || !currentRoute.route_id) {
    routeGeometry = null;
    routeGeometryRouteId = null;
    return;
  }
  // If we've already attempted to load geometry for this route (success or failure), skip.
  if (routeGeometryRouteId === currentRoute.route_id) {
    return;
  }
  // If there are no stops, skip geometry fetch and mark as attempted.
  if (!currentRoute.stops || currentRoute.stops.length === 0) {
    routeGeometry = null;
    routeGeometryRouteId = currentRoute.route_id;
    return;
  }
  try {
    const data = await api(`/routes/${currentRoute.route_id}/geometry`);
    routeGeometry = data.coordinates || null;
    routeGeometryRouteId = currentRoute.route_id;
  } catch (e) {
    if (e.message && e.message.includes("Route has no customers")) {
      // ignore silently
    } else {
      console.warn("Failed to load route geometry:", e);
    }
    routeGeometry = null;
    routeGeometryRouteId = currentRoute.route_id;
  }
}

// ---------------- Rendering: stop list ----------------
function renderStops() {
  const list = $id("stopsList");
  list.innerHTML = "";

  const stops = currentRoute && currentRoute.stops ? currentRoute.stops.slice().sort((a, b) => (a.sequence || 0) - (b
    .sequence || 0)) : [];
  if (!stops.length) {
    list.innerHTML = `<li class="empty-row">No route assigned yet</li>`;
    return;
  }

  const currentStopId = currentLeg && !currentLeg.route_completed ? currentLeg.to_customer_id : null;

  stops.forEach((stop, index) => {
    const li = document.createElement("li");
    let statusClass = stop.status || "pending";
    let statusLabel = "Pending";
    if (stop.status === "collected") statusLabel = "Completed";
    else if (stop.status === "skipped") statusLabel = "Skipped";
    else if (stop.status === "absent") statusLabel = "Absent";
    else if (stop.customer_id === currentStopId) {
      statusClass = "current";
      statusLabel = hasShownArrivedFor === stop.customer_id ? "Arrived!" : "Moving";
    }
    li.className = `stop-item ${statusClass}`;

    const iconContent = stop.status === "collected" ?
      '<i class="fas fa-check"></i>' :
      (stop.status === "skipped" || stop.status === "absent") ?
      '<i class="fas fa-xmark"></i>' :
      (index + 1);

    const timeLabel = stop.completed_at ? escapeHtml(stop.completed_at) : "";
    const rightMeta = statusClass === "current" ?
      `<div class="stop-meta-right"><span class="stop-badge-moving">${escapeHtml(statusLabel)}</span></div>` :
      `<div class="stop-chevron"></div>`;

    li.innerHTML = `
      <div class="stop-index">${iconContent}</div>
      <div class="stop-info">
        <div class="stop-name">${escapeHtml(stop.name)}</div>
        <div class="stop-address">${escapeHtml(stop.address || stop.phone || "")}</div>
        <div class="stop-status ${statusClass}">${escapeHtml(statusLabel)}${timeLabel ? " • " + timeLabel : ""}</div>
      </div>
      ${rightMeta}
    `;
    list.appendChild(li);
  });
}

function updateProgress() {
  const stops = currentRoute && currentRoute.stops ? currentRoute.stops : [];
  const total = stops.length;
  const done = stops.filter((s) => s.status !== "pending").length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  $id("progressPercent").textContent = `${pct}%`;
  $id("progressFill").style.width = `${pct}%`;
  $id("progressText").textContent = `${done} of ${total} stops completed`;
  $id("statStopsCompleted").textContent = `${done} of ${total}`;
  $id("stripStopsCompleted").textContent = `${done} of ${total}`;
}

// ---------------- Rendering: current stop card ----------------
function renderCurrentStopCard() {
  const card = $id("currentStopCard");
  if (!currentLeg || currentLeg.route_completed || !currentLeg.to_point) {
    card.style.display = "none";
    return;
  }
  if (cardDismissedFor === currentLeg.to_customer_id) {
    card.style.display = "none";
    return;
  }

  card.style.display = "block";
  const stop = (currentRoute && currentRoute.stops || []).find((s) => s.customer_id === currentLeg.to_customer_id);
  const idx = (currentRoute && currentRoute.stops || []).findIndex((s) => s.customer_id === currentLeg.to_customer_id);

  $id("csEyebrow").textContent = hasShownArrivedFor === currentLeg.to_customer_id ? "Arrived at stop" :
    "Moving to next stop";
  $id("csName").textContent = currentLeg.to_point.label || (stop && stop.name) || "—";
  $id("csAddress").textContent = currentLeg.to_point.address || (stop && stop.address) || "No address on file";
  $id("csPhone").textContent = currentLeg.to_point.phone || (stop && stop.phone) || "—";
  $id("csAmount").textContent = formatCurrency(stop ? stop.default_amount : 0);
  $id("csEta").textContent = currentLeg.eta_minutes != null ? `${Math.round(currentLeg.eta_minutes)} min` : "—";
  $id("csDistance").textContent = currentLeg.distance_km != null ? `${currentLeg.distance_km} km` : "—";
  $id("csSequence").textContent = (currentRoute && currentRoute.stops) ? `${idx + 1} of ${currentRoute.stops.length}` :
    "—";
}

// ---------------- Stats ----------------
function updateStats() {
  updateProgress();

  const stops = validStops();
  const total = totalRouteDistanceKm(stops);
  const remaining = remainingDistanceKm(stops);
  const etaMin = estimateMinutes(remaining);

  $id("statTotalDistance").textContent = `${total.toFixed(1)} km`;
  $id("stripTotalDistance").textContent = `${total.toFixed(1)} km`;
  $id("stripRemainingDistance").textContent = `${remaining.toFixed(1)} km`;

  const etaText = etaMin != null ? `${Math.round(etaMin)} min` : "—";
  $id("statEta").textContent = etaText;
  $id("stripEta").textContent = etaText;

  const allStops = currentRoute && currentRoute.stops ? currentRoute.stops : [];
  const collected = allStops
    .filter((s) => s.status === "collected")
    .reduce((sum, s) => sum + (s.amount_collected != null ? s.amount_collected : (s.default_amount || 0)), 0);
  const pending = allStops
    .filter((s) => s.status !== "collected")
    .reduce((sum, s) => sum + (s.default_amount || 0), 0);

  $id("statAmountCollected").textContent = formatCurrency(collected);
  $id("stripAmountCollected").textContent = formatCurrency(collected);
  $id("stripPendingAmount").textContent = formatCurrency(pending);
}

// ---------------- Mark modal ----------------
let modalCustomerId = null;

function openMarkModal(customerId, name, amount, address) {
  modalCustomerId = customerId;
  $id("modalCustomerName").textContent = name || "—";
  $id("modalAddress").textContent = address || "";
  $id("modalAmount").value = amount || "";
  $id("markModal").style.display = "flex";
}

function closeMarkModal() {
  modalCustomerId = null;
  $id("markModal").style.display = "none";
}

async function markStop(status) {
  if (!modalCustomerId) return;
  const amountStr = $id("modalAmount").value;
  const amount = status === "collected" && amountStr ? parseFloat(amountStr) : null;
  try {
    await api(`/collections/${modalCustomerId}/mark`, {
      method: "POST",
      body: JSON.stringify({ status, amount_collected: amount }),
    });
  } catch (e) {
    if (!usingLocalLeg) { alert("Couldn't update stop. Try again."); return; }
    const stop = currentRoute && currentRoute.stops && currentRoute.stops.find((s) => s.customer_id ===
      modalCustomerId);
    if (stop) {
      stop.status = status;
      if (amount != null) stop.amount_collected = amount;
    }
  }
  closeMarkModal();
  hasShownArrivedFor = null;
  cardDismissedFor = null;
  await refreshAll();
}

async function skipStopDirect(customerId) {
  try {
    await api(`/collections/${customerId}/mark`, {
      method: "POST",
      body: JSON.stringify({ status: "skipped", amount_collected: null }),
    });
  } catch (e) {
    if (!usingLocalLeg) { alert("Couldn't update stop. Try again."); return; }
    const stop = currentRoute && currentRoute.stops && currentRoute.stops.find((s) => s.customer_id === customerId);
    if (stop) stop.status = "skipped";
  }
  hasShownArrivedFor = null;
  cardDismissedFor = null;
  await refreshAll();
}

function openNavigation(lat, lng) {
  window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`, "_blank");
}

function callNumber(phone) {
  if (!phone || phone === "—") return;
  window.location.href = `tel:${phone}`;
}

// ---------------- End Route ----------------
async function endRoute() {
  if (!confirm("Are you sure you want to end your route? This will stop tracking.")) return;
  stopGpsTracking();
  handleLogout();
}

// ---------------- Init ----------------
document.addEventListener("DOMContentLoaded", () => {
  $id("loginBtn").addEventListener("click", handleLogin);
  $id("phoneInput").addEventListener("keydown", (e) => { if (e.key === "Enter") handleLogin(); });
  $id("logoutBtn").addEventListener("click", handleLogout);
  $id("refreshBtn").addEventListener("click", refreshAll);
  $id("endRouteBtn").addEventListener("click", endRoute);

  $id("markPaidBtn").addEventListener("click", () => markStop("collected"));
  $id("markSkippedBtn").addEventListener("click", () => markStop("skipped"));
  $id("markAbsentBtn").addEventListener("click", () => markStop("absent"));
  $id("modalCancelBtn").addEventListener("click", closeMarkModal);

  $id("closeCurrentStopCard").addEventListener("click", () => {
    if (currentLeg) cardDismissedFor = currentLeg.to_customer_id;
    $id("currentStopCard").style.display = "none";
  });

  $id("csNavigateBtn").addEventListener("click", () => {
    if (currentLeg && currentLeg.to_point) openNavigation(currentLeg.to_point.latitude, currentLeg.to_point
      .longitude);
  });
  $id("csCallBtn").addEventListener("click", () => {
    if (currentLeg && currentLeg.to_point) callNumber(currentLeg.to_point.phone);
  });
  $id("csMarkBtn").addEventListener("click", () => {
    if (!currentLeg || !currentLeg.to_customer_id) return;
    const stop = currentRoute && currentRoute.stops && currentRoute.stops.find((s) => s.customer_id ===
      currentLeg.to_customer_id);
    openMarkModal(currentLeg.to_customer_id, currentLeg.to_point.label, stop ? stop.default_amount : 0,
      currentLeg.to_point.address);
  });
  $id("csSkipBtn").addEventListener("click", () => {
    if (currentLeg && currentLeg.to_customer_id) skipStopDirect(currentLeg.to_customer_id);
  });

  $id("sidebarToggle") && $id("sidebarToggle").addEventListener("click", () => {
    $id("sidebar").classList.toggle("open");
  });
const navSectionMap = {
  "route": "section-route",
  "stops": "section-stops",
};

document.querySelectorAll(".sidebar-nav a").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      document.querySelectorAll(".sidebar-nav a").forEach((x) => x.classList.remove("active"));
      a.classList.add("active");

      const sectionId = navSectionMap[a.dataset.nav];
      if (sectionId) {
        const el = document.getElementById(sectionId);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      } else {
        alert(`"${a.textContent.trim()}" isn't built yet — coming soon.`);
      }
    });
  });

  const saved = localStorage.getItem("collector");
  if (saved) {
    currentCollector = JSON.parse(saved);
    startSession();
  } else {
    showScreen("login");
  }
});