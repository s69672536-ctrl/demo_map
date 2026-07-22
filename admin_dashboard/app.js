// Puthusu Admin Dashboard
//
// Real backend calls go through api(); if the backend isn't reachable
// (or API_BASE_URL in config.js is left as the placeholder), the dashboard
// falls back to keeping everything in local memory (`store` below) so the
// UI still works while you're building without a backend.
//
// Nothing is pre-filled. Customers, collectors, the route timeline, and
// notifications all start empty and only appear once you add them through
// the "Add" buttons (or once a real route is built).

let map;
let startMarker, endMarker;
let mode = "set-start"; // map is click-ready immediately: first click sets start, next sets end
let pendingCustomerMarker = null; // temp marker shown while placing a new customer via map click
let currentRoute = null;
let customerMarkers = [];
let routeLine = null;
let selectedCollectorId = null;
let liveMarker = null;
let livePollTimer = null;
let usingLocalStore = false;

let editingCollectorId = null;
let editingCustomerId = null;
function $id(id) { return document.getElementById(id); }

function isNetworkError(error) {
  return error instanceof TypeError;
}

function setRouteActionMode(hasActiveRoute) {
  const button = $id("createRouteBtn");
  if (!button) return;
  button.innerHTML = hasActiveRoute
    ? '<i class="fas fa-diagram-project"></i> Optimize Route'
    : '<i class="fas fa-diagram-project"></i> Create Route';
}

function formatCurrency(n) {
  return `₹${Math.round(n || 0).toLocaleString("en-IN")}`;
}

// ---------------- Local store (starts empty) ----------------
const store = {
  customers: [],
  collectors: [],
  notifications: [],
  routes: [],
};

// ---------------- Distance helpers (real haversine, no invented numbers) ----------------
function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLng = ((b[1] - a[1]) * Math.PI) / 180;
  const lat1 = (a[0] * Math.PI) / 180;
  const lat2 = (b[0] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function routeDistanceKm(latlngs) {
  let d = 0;
  for (let i = 1; i < latlngs.length; i++) d += haversineKm(latlngs[i - 1], latlngs[i]);
  return d;
}

// ---------------- Map ----------------
function initMap() {
  map = L.map("map", { zoomControl: false }).setView([13.0850, 80.2200], 12);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap &copy; CARTO",
    subdomains: "abcd",
    maxZoom: 20,
  }).addTo(map);
  L.control.zoom({ position: "topleft" }).addTo(map);
  map.on("click", onMapClick);
}

function numberedIcon(number, color) {
  return L.divIcon({
    className: "",
    html: `<div style="width:30px;height:30px;border-radius:50%;background:${color};color:#fff;
            display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;
            box-shadow:0 3px 10px rgba(0,0,0,0.25);border:2px solid #fff;">${number}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}
function liveIcon() {
  return L.divIcon({
    className: "",
    html: `<div class="live-marker-wrap"><div class="live-marker-ring"></div><div class="live-marker-dot"></div></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}
function onMapClick(e) {
  const { lat, lng } = e.latlng;
  if (mode === "set-start") {
    if (startMarker) map.removeLayer(startMarker);
    startMarker = L.marker([lat, lng]).addTo(map).bindPopup("Start");
    $id("startLabel").value = `Start: ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    mode = "set-end";
  } else if (mode === "set-end") {
    if (endMarker) map.removeLayer(endMarker);
    endMarker = L.marker([lat, lng]).addTo(map).bindPopup("End");
    $id("endLabel").value = `End: ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    mode = "idle";
  } else if (mode === "add-customer") {
    placePendingCustomerMarker(lat, lng);
    mode = "idle";
    openCustomerModal(lat, lng);
    return;
  }
  syncMapMarkers();
}

// ---------------- Pending "add customer" marker (click-to-place) ----------------
function placePendingCustomerMarker(lat, lng) {
  if (pendingCustomerMarker) map.removeLayer(pendingCustomerMarker);
  pendingCustomerMarker = L.marker([lat, lng], { icon: numberedIcon("+", "#3B82F6") })
    .addTo(map)
    .bindPopup("New customer location");
}

function clearPendingCustomerMarker() {
  if (pendingCustomerMarker) { map.removeLayer(pendingCustomerMarker); pendingCustomerMarker = null; }
}

function clearCustomerMapLayers() {
  customerMarkers.forEach((m) => map.removeLayer(m));
  customerMarkers = [];
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
}
// ---------------- Live collector location (View Live button) ----------------
function clearLiveMarker() {
  if (livePollTimer) { clearInterval(livePollTimer); livePollTimer = null; }
  if (liveMarker) { map.removeLayer(liveMarker); liveMarker = null; }
}

async function fetchAndPlaceLiveMarker(id) {
  let summary;
  try {
    summary = await api("/tracking/summary");
  } catch (e) {
    return;
  }

  const entry = summary.find((s) => s.collector_id == id);
  if (selectedCollectorId != id) return;

  if (!entry || entry.latitude == null || entry.longitude == null) {
    clearLiveMarker();
    addNotification("info", `${collectorNameById(id)} hasn't shared a live location yet.`);
    return;
  }

  const latlng = [entry.latitude, entry.longitude];
  const popup = `<b>${entry.collector_name}</b><br>${entry.route_name || "No route today"}<br>
    ${entry.distance_km_today.toFixed(2)} km travelled today<br>
    <span style="color:#6B7280;font-size:12px;">Updated ${new Date(entry.last_updated).toLocaleTimeString()}</span>`;

  if (liveMarker) {
    liveMarker.setLatLng(latlng).setPopupContent(popup);
  } else {
    liveMarker = L.marker(latlng, { icon: liveIcon(), zIndexOffset: 1000 })
      .addTo(map)
      .bindPopup(popup)
      .openPopup();
  }
  map.panTo(latlng);
}

function showCollectorLive(id) {
  clearLiveMarker();
  fetchAndPlaceLiveMarker(id);
  livePollTimer = setInterval(() => fetchAndPlaceLiveMarker(id), 8000);
}
// Redraws customer markers + route line from whatever is currently in
// store.customers. Called after every add/load so the map always reflects
// real data — nothing is drawn until a customer with real coordinates exists.
function syncMapMarkers() {
  clearCustomerMapLayers();

  const stops = store.customers
    .filter((c) => c.lat != null && c.lng != null && !Number.isNaN(c.lat) && !Number.isNaN(c.lng))
    .sort((a, b) => (a.sequence || 0) - (b.sequence || 0));

  if (!stops.length) {
    resetDistanceStats();
    return;
  }

  stops.forEach((c) => {
    const color = c.status === "done" ? "#22C55E" : c.status === "moving" ? "#3B82F6" : "#111827";
    const marker = L.marker([c.lat, c.lng], { icon: numberedIcon(c.sequence || "•", color) })
      .addTo(map)
      .bindPopup(`<b>${c.name}</b><br>${c.address || ""}<br>${formatCurrency(c.amount)}`);
    customerMarkers.push(marker);
  });

  const stopLatLngs = stops.map((c) => [c.lat, c.lng]);
  const drawLatLngs = [...stopLatLngs];
  if (startMarker) drawLatLngs.unshift([startMarker.getLatLng().lat, startMarker.getLatLng().lng]);
  if (endMarker) drawLatLngs.push([endMarker.getLatLng().lat, endMarker.getLatLng().lng]);

  if (drawLatLngs.length > 1) {
    routeLine = L.polyline(drawLatLngs, { color: "#3B82F6", weight: 5, opacity: 0.85, dashArray: "10 8" }).addTo(map);
    map.fitBounds(L.latLngBounds(drawLatLngs), { padding: [70, 70] });
  } else {
    map.setView(stopLatLngs[0], 15);
  }

  updateDistanceStats(stopLatLngs, stops);
}

function resetDistanceStats() {
  $id("totalDistance").textContent = "0 km";
  $id("statTodayDistance").textContent = "0 km";
  $id("remainingDistance").textContent = "0 km";
  $id("estimatedTime").textContent = "—";
  $id("stopsCompleted").textContent = "0 / 0";
}

function updateDistanceStats(stopLatLngs, stops) {
  const total = routeDistanceKm(stopLatLngs);
  $id("totalDistance").textContent = `${total.toFixed(1)} km`;
  $id("statTodayDistance").textContent = `${total.toFixed(1)} km`;

  const doneCount = stops.filter((c) => c.status === "done").length;
  const firstPendingIdx = stops.findIndex((c) => c.status !== "done");
  const remaining = firstPendingIdx > -1 ? routeDistanceKm(stopLatLngs.slice(firstPendingIdx)) : 0;
  $id("remainingDistance").textContent = `${remaining.toFixed(1)} km`;
  // No live GPS/speed data to derive a real ETA from, so we don't invent one.
  $id("estimatedTime").textContent = "—";
  $id("stopsCompleted").textContent = `${doneCount} / ${stops.length}`;
}

function updateNextStopCard() {
  const card = $id("nextStopCard");
  const next = store.customers
    .filter((c) => c.status !== "done" && c.lat != null && c.lng != null)
    .sort((a, b) => (a.sequence || 0) - (b.sequence || 0))[0];

  if (!next) {
    card.style.display = "none";
    return;
  }

  card.style.display = "flex";
  $id("nextStopName").textContent = next.name;
  $id("nextStopAddr").textContent = next.address || "No address set";
  $id("nextStopAmount").textContent = formatCurrency(next.amount);

  if (startMarker) {
    const start = startMarker.getLatLng();
    const dist = haversineKm([start.lat, start.lng], [next.lat, next.lng]);
    $id("nextStopDist").textContent = `${dist.toFixed(2)} km`;
  } else {
    $id("nextStopDist").textContent = "—";
  }
  $id("nextStopEta").textContent = "—";
}

// ---------------- API helper ----------------
async function api(path, options = {}) {
  const res = await fetch(`${CONFIG.API_BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
  return res.status === 204 ? null : res.json();
}

// ---------------- Customers ----------------
function statusDotHtml(status) {
  if (status === "done") return `<span class="status-dot done"><i class="fas fa-check"></i></span>`;
  if (status === "moving") return `<span class="status-dot moving"><i class="fas fa-arrow-right"></i></span>`;
  return `<span class="status-dot pending"><i class="fas fa-plus"></i></span>`;
}

// Opens a read-only details view for one customer (triggered by clicking their row)
function showCustomerDetails(id) {
  const c = store.customers.find((cust) => cust.id == id);
  if (!c) return;

  $id("detailName").textContent = c.name || "—";
  $id("detailPhone").textContent = c.phone || "—";
  $id("detailAddress").textContent = c.address || "—";
  $id("detailAmount").textContent = formatCurrency(c.amount);
  $id("detailSequence").textContent = c.sequence ?? "—";
  $id("detailStatus").innerHTML = statusDotHtml(c.status);
  $id("detailCoords").textContent =
    c.lat != null && c.lng != null ? `${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}` : "—";
  $id("detailPermanent").textContent = c.permanent ? "Yes" : "No";

  const img = $id("detailImage");
  if (c.house_image_path) {
    img.src = `${API_BASE_URL}${c.house_image_path}`;
    img.style.display = "block";
  } else {
    img.style.display = "none";
  }

  $id("customerDetailsModal").style.display = "flex";

  if (map && c.lat != null && c.lng != null) {
    map.setView([c.lat, c.lng], 16);
  }
}

function renderCustomers(customers) {
  const tbody = $id("customerList");
  tbody.innerHTML = "";

  if (!customers.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-row">No customers yet — click "Add" to add one</td></tr>`;
    return;
  }

  customers
    .slice()
    .sort((a, b) => (a.sequence || 0) - (b.sequence || 0))
    .forEach((c) => {
      const tr = document.createElement("tr");
      tr.className = "clickable-row";
      tr.setAttribute("data-action", "view-customer");
      tr.setAttribute("data-id", c.id);
      tr.innerHTML = `
        <td>${c.name}</td>
        <td>${formatCurrency(c.amount)}</td>
        <td>${c.sequence ?? ""}</td>
        <td>${statusDotHtml(c.status)}</td>
        <td class="row-actions">
          <button class="edit-btn" data-action="edit-customer" data-id="${c.id}" title="Edit"><i class="fas fa-pen"></i></button>
          <button class="remove-btn" data-action="remove-customer" data-id="${c.id}" title="Remove"><i class="fas fa-trash"></i></button>
        </td>
      `;
      tbody.appendChild(tr);
    });
}

// Separate, dedicated list of customers that were saved as "Permanent" —
// kept visually and structurally apart from the regular (today-only) list.
function renderPermanentCustomers() {
  const tbody = $id("permanentCustomerList");
  if (!tbody) return;
  tbody.innerHTML = "";

  const permanentCustomers = store.customers.filter((c) => c.permanent);

  if (!permanentCustomers.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-row">No permanent customers yet</td></tr>`;
    return;
  }

  permanentCustomers
    .slice()
    .sort((a, b) => (a.sequence || 0) - (b.sequence || 0))
    .forEach((c) => {
      const tr = document.createElement("tr");
      tr.className = "clickable-row";
      tr.setAttribute("data-action", "view-customer");
      tr.setAttribute("data-id", c.id);
      tr.innerHTML = `
        <td>${c.name}</td>
        <td>${formatCurrency(c.amount)}</td>
        <td>${c.sequence ?? ""}</td>
        <td>${statusDotHtml(c.status)}</td>
        <td class="row-actions">
          <button class="edit-btn" data-action="edit-customer" data-id="${c.id}" title="Edit"><i class="fas fa-pen"></i></button>
          <button class="remove-btn" data-action="remove-customer" data-id="${c.id}" title="Remove"><i class="fas fa-trash"></i></button>
        </td>
      `;
      tbody.appendChild(tr);
    });
}

async function loadCustomers() {
  if (usingLocalStore || !currentRoute) {
    renderCustomers(store.customers.filter((c) => !c.permanent));
    renderPermanentCustomers();
    renderTimeline();
    syncMapMarkers();
    recalcStats();
    return;
  }
  try {
    const remote = await api(`/routes/${currentRoute.id}/customers`);
    const remoteMapped = remote.map((c) => ({
      id: c.id, name: c.name, phone: c.phone, address: c.address,
      amount: c.default_amount || 0, sequence: c.sequence, status: c.status || "pending",
      lat: c.latitude, lng: c.longitude, permanent: !!c.permanent,
      house_image_path: c.house_image_path || null,
    }));
    // Preserve any locally-added permanent customers alongside remote ones.
    const localPermanent = store.customers.filter((c) => c.permanent && !remoteMapped.some((r) => r.id === c.id));
    store.customers = [...remoteMapped, ...localPermanent];
    renderCustomers(store.customers.filter((c) => !c.permanent));
    renderPermanentCustomers();
    renderTimeline();
    syncMapMarkers();
    recalcStats();
  } catch (e) {
    usingLocalStore = true;
    renderCustomers(store.customers.filter((c) => !c.permanent));
    renderPermanentCustomers();
    renderTimeline();
    syncMapMarkers();
    recalcStats();
  }
}
async function removeCustomer(id) {
  const numericId = /^\d+$/.test(id) ? Number(id) : id;
  const customer = store.customers.find((c) => c.id == numericId);
try {
    if (!usingLocalStore && customer && !customer.draft) {
      await api(`/customers/${numericId}`, { method: "DELETE" });
    } else {
      throw new Error("local-only — skip remote delete");
    }
  } catch (e) {
    // Fall through to local removal regardless of backend result.
  }
  store.customers = store.customers.filter((c) => c.id != numericId);
  if (customer) addNotification("warning", `Customer removed: ${customer.name}`);
  await loadCustomers();
}

// ---------------- Collectors ----------------
function renderCollectors(list) {
  const container = $id("collectorList");
  container.innerHTML = "";

  if (!list.length) {
    container.innerHTML = `<div class="empty-row">No collectors yet — click "Add" to add one</div>`;
    return;
  }

  list.forEach((c) => {
    const initials = c.name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
    const div = document.createElement("div");
    div.className = "collector-card";
    div.innerHTML = `
      <button class="remove-btn corner" data-action="remove-collector" data-id="${c.id}" title="Remove"><i class="fas fa-xmark"></i></button>
      <button class="edit-btn corner-edit" data-action="edit-collector" data-id="${c.id}" title="Edit"><i class="fas fa-pen"></i></button>
      <div class="avatar-circle">${initials}</div>
      <div class="c-name">${c.name}</div>
      <div class="c-status ${c.online ? "online" : "offline"}"><i class="fas fa-circle" style="font-size:7px;"></i> ${c.online ? "Online" : "Offline"}</div>
      <div class="c-battery ${c.battery <= 20 ? "low" : ""}">Battery ${c.battery}%</div>
      <div class="c-stats">${formatCurrency(c.amount)}<br><b>${c.km} km</b></div>
      <button class="view-live-btn ${c.online ? "" : "offline"}">View Live</button>
    `;
    div.querySelector(".view-live-btn").addEventListener("click", () => selectCollector(c.id));
    container.appendChild(div);
  });
}

async function loadCollectors() {
  try {
    const remote = await api("/collectors");
 store.collectors = remote.map((c) => ({
  id: c.id, name: c.name, phone: c.phone, online: !!c.active, battery: 80, amount: 0, km: 0,
}));
    usingLocalStore = false;
  } catch (e) {
    usingLocalStore = true;
    // Backend unreachable — keep whatever's already in local store (starts empty).
  }
  renderCollectors(store.collectors);
  renderCollectorSelect();
  recalcStats();
}

// Keeps the "Assign To Collector" dropdown (used both at route-creation time
// and for the per-route Assign/Make Permanent buttons below) in sync with
// whatever collectors actually exist on the backend.
function renderCollectorSelect() {
  const select = $id("assignCollectorSelect");
  if (!select) return;
  const previousValue = select.value;
  select.innerHTML = `<option value="">Select a collector…</option>`;
  store.collectors.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name;
    select.appendChild(opt);
  });
  if (previousValue && store.collectors.some((c) => c.id == previousValue)) {
    select.value = previousValue;
  }
}

async function removeCollector(id) {
  const numericId = /^\d+$/.test(id) ? Number(id) : id;
  const collector = store.collectors.find((c) => c.id == numericId);

  try {
    if (!usingLocalStore) {
      await api(`/collectors/${numericId}`, { method: "DELETE" });
    } else {
      throw new Error("local store — skip remote delete");
    }
  } catch (e) {
    // Fall through to local removal regardless of backend result.
  }

  store.collectors = store.collectors.filter((c) => c.id != numericId);
  if (selectedCollectorId == numericId) { selectedCollectorId = null; clearLiveMarker(); }
  if (collector) addNotification("warning", `Collector removed: ${collector.name}`);
  renderCollectors(store.collectors);
  recalcStats();
}
async function selectCollector(id) {
  selectedCollectorId = id;
  showCollectorLive(id);

  clearCustomerMapLayers();
  try {
    const today = await api(`/collections/today?collector_id=${id}`);
    if (!today || !today.route_id) {
      addNotification("warning", "This collector has no route assigned today.");
      return;
    }
    currentRoute = { id: today.route_id, name: today.route_name };

    const stops = (today.stops || [])
      .filter((s) => s.latitude != null && s.longitude != null)
      .sort((a, b) => (a.sequence || 0) - (b.sequence || 0));

    stops.forEach((s, idx) => {
      const color = s.status === "collected" ? "#22C55E"
        : (s.status === "skipped" || s.status === "absent") ? "#F59E0B"
        : "#111827";
      const marker = L.marker([s.latitude, s.longitude], { icon: numberedIcon(idx + 1, color) })
        .addTo(map)
        .bindPopup(`<b>${s.name}</b><br>${formatCurrency(s.default_amount)}`);
      customerMarkers.push(marker);
    });

    const geo = await api(`/routes/${today.route_id}/geometry`);
    if (geo && geo.coordinates && geo.coordinates.length > 1) {
      routeLine = L.polyline(
        geo.coordinates.map((c) => [c[0], c[1]]),
        { color: "#2563EB", weight: 5, opacity: 0.9 }
      ).addTo(map);
      map.fitBounds(routeLine.getBounds(), { padding: [50, 50] });
    }
  } catch (e) {
    addNotification("danger", `Could not load today's route: ${e.message}`);
  }
}

// ---------------- Saved Routes (Permanent vs Today Only) ----------------
// Loaded straight from the backend (GET /routes) rather than kept in local
// memory - previously the list reset to empty on every page reload, which is
// why the same route kept getting rebuilt from scratch (visible in the UI as
// several identically-named "saved routes"): the earlier ones were never
// gone, just no longer shown, so nothing was actually deduplicated or cleaned
// up on the backend.
async function loadRoutes() {
  try {
    const remote = await api("/routes");
    store.routes = remote.map((r) => ({
      id: r.id,
      name: r.route_name,
      defaultCollectorId: r.default_collector_id ?? null,
    }));
    usingLocalStore = false;
  } catch (e) {
    // Backend unreachable — keep whatever's already in local store.
  }
  renderRoutesList();
}

function collectorNameById(id) {
  if (id == null) return null;
  const c = store.collectors.find((c) => c.id == id);
  return c ? c.name : `#${id}`;
}

// ---------- NEW: View route on map ----------
async function viewRouteOnMap(routeId) {
  let route;
  try {
    route = await api(`/routes/${routeId}`);
  } catch (e) {
    addNotification("danger", `Could not load route: ${e.message}`);
    return;
  }

  // Reset any leftover builder state before loading this route in.
  clearPendingCustomerMarker();
  clearCustomerMapLayers();
  clearLiveMarker();
  if (startMarker) { map.removeLayer(startMarker); startMarker = null; }
  if (endMarker) { map.removeLayer(endMarker); endMarker = null; }

  currentRoute = { id: route.id, name: route.route_name };
  usingLocalStore = false;
  mode = "idle";
  setRouteActionMode(true);

  $id("routeName").value = route.route_name || "";
  startMarker = L.marker([route.start_lat, route.start_lng]).addTo(map).bindPopup("Start");
  endMarker = L.marker([route.end_lat, route.end_lng]).addTo(map).bindPopup("End");
  $id("startLabel").value = `Start: ${route.start_lat.toFixed(5)}, ${route.start_lng.toFixed(5)}`;
  $id("endLabel").value = `End: ${route.end_lat.toFixed(5)}, ${route.end_lng.toFixed(5)}`;

  // Populates the customer table (editable/deletable from here on) and
  // draws the straight-line preview between stops.
  await loadCustomers();

  // Overlay the actual road-following path on top of that preview, if available.
  try {
    const data = await api(`/routes/${routeId}/geometry`);
    if (data && data.coordinates && data.coordinates.length > 1) {
      const latlngs = data.coordinates.map((c) => [c[0], c[1]]);
      if (routeLine) map.removeLayer(routeLine);
      routeLine = L.polyline(latlngs, { color: "#2563EB", weight: 5, opacity: 0.9 }).addTo(map);
      map.fitBounds(L.polyline(latlngs).getBounds(), { padding: [40, 40] });
    }
  } catch (e) {
    // No geometry yet (e.g. route has no customers) — the straight-line preview is enough.
  }

  addNotification("info", `Route "${route.route_name}" loaded — add, edit, or remove its customers below.`);
}

function renderRoutesList() {
  const container = $id("savedRoutesList");
  if (!container) return;
  container.innerHTML = "";

  if (!store.routes.length) {
    container.innerHTML = `<div class="empty-row">No saved routes yet — build one above</div>`;
    return;
  }

  store.routes
    .slice()
    .reverse()
    .forEach((r) => {
      const assignedName = collectorNameById(r.defaultCollectorId);
      const badgeClass = r.defaultCollectorId ? "permanent" : "unassigned";
      const badgeText = assignedName ? `Permanent: ${assignedName}` : "Unassigned";

      const div = document.createElement("div");
      div.className = "route-row";
      div.innerHTML = `
        <div class="route-row-info">
          <span class="route-name">${r.name}</span>
          <span class="route-type-badge ${badgeClass}">${badgeText}</span>
        </div>
        <div class="route-row-actions">
          <!-- NEW: View on Map button -->
          <button class="chip-btn primary" data-action="view-route-map" data-id="${r.id}" title="View this route on the map">🗺️ View</button>
          <button class="chip-btn" data-action="assign-today-route" data-id="${r.id}" title="Assign the collector selected above to this route for today only">Assign Today</button>
          <button class="chip-btn primary" data-action="assign-permanent-route" data-id="${r.id}" title="Make the collector selected above permanently own this route">Make Permanent</button>
          ${r.defaultCollectorId ? `<button class="chip-btn" data-action="clear-permanent-route" data-id="${r.id}" title="Remove the permanent owner">Clear</button>` : ""}
          <button class="remove-btn" data-action="remove-route" data-id="${r.id}" title="Delete this route"><i class="fas fa-trash"></i></button>
        </div>
      `;
      container.appendChild(div);
    });
}

function getSelectedAssignCollectorId() {
  const select = $id("assignCollectorSelect");
  const val = select ? select.value : "";
  return val ? Number(val) : null;
}

async function assignRouteToday(routeId) {
  const collectorId = getSelectedAssignCollectorId();
  if (!collectorId) { alert("Pick a collector from the \"Assign To Collector\" dropdown first."); return; }
  try {
    await api("/collectors/assignments", {
      method: "POST",
      body: JSON.stringify({ route_id: routeId, collector_id: collectorId }),
    });
    addNotification("success", `${collectorNameById(collectorId)} assigned to this route for today`);
  } catch (e) {
    alert(`Couldn't assign collector: ${e.message}`);
  }
}

async function makeRoutePermanent(routeId) {
  const collectorId = getSelectedAssignCollectorId();
  if (!collectorId) { alert("Pick a collector from the \"Assign To Collector\" dropdown first."); return; }
  try {
    await api(`/routes/${routeId}/default-collector`, {
      method: "PUT",
      body: JSON.stringify({ collector_id: collectorId }),
    });
    addNotification("success", `${collectorNameById(collectorId)} is now the permanent owner of this route`);
    await loadRoutes();
  } catch (e) {
    alert(`Couldn't set permanent collector: ${e.message}`);
  }
}

async function clearRoutePermanent(routeId) {
  try {
    await api(`/routes/${routeId}/default-collector`, { method: "DELETE" });
    addNotification("info", "Permanent owner removed from this route");
    await loadRoutes();
  } catch (e) {
    alert(`Couldn't clear permanent collector: ${e.message}`);
  }
}

async function removeRoute(id) {
  const numericId = /^\d+$/.test(id) ? Number(id) : id;
  const route = store.routes.find((r) => r.id == numericId);

  try {
    await api(`/routes/${numericId}`, { method: "DELETE" });
  } catch (e) {
    alert(`Couldn't delete route on the server: ${e.message}`);
    return;
  }

  if (currentRoute && currentRoute.id == numericId) {
    clearRoute();
  }
  if (route) addNotification("warning", `Route removed: ${route.name}`);
  await loadRoutes();
}

// ---------------- Timeline (derived from real customers, not a fixed list) ----------------
function renderTimeline() {
  const container = $id("routeTimeline");
  container.innerHTML = "";

  const stops = store.customers.slice().sort((a, b) => (a.sequence || 0) - (b.sequence || 0));

  if (!stops.length) {
    container.innerHTML = `<div class="empty-row">No stops yet — add customers or build a route to see the timeline</div>`;
    return;
  }

  stops.forEach((c, idx) => {
    const status = c.status || "pending";
    const label = status === "done" ? "Completed" : status === "moving" ? "Moving" : "Pending";
    const dotContent = status === "done" ? '<i class="fas fa-check"></i>' : status === "moving" ? '<i class="fas fa-arrow-right"></i>' : idx + 1;
    const time = c.addedAt || "";
    const div = document.createElement("div");
    div.className = "timeline-item";
    div.innerHTML = `
      <div class="timeline-dot ${status}">${dotContent}</div>
      <div class="timeline-info">
        <div class="t-name">${c.name}</div>
        <div class="t-status ${status}">${label}</div>
      </div>
      <div class="timeline-time">${time}</div>
    `;
    container.appendChild(div);
  });
}

// ---------------- Notifications (generated by real events only) ----------------
function addNotification(type, text) {
  store.notifications.unshift({
    type,
    text,
    time: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }),
  });
  store.notifications = store.notifications.slice(0, 30);
  renderNotifications();
}

function renderNotifications() {
  const container = $id("notificationList");
  container.innerHTML = "";

  const badgeCount = store.notifications.length;
  const navBadge = $id("navNotifBadge");
  const headerBadge = $id("headerNotifBadge");
  if (navBadge) navBadge.textContent = badgeCount;
  if (headerBadge) headerBadge.textContent = badgeCount;

  if (!store.notifications.length) {
    container.innerHTML = `<div class="empty-row">No notifications yet</div>`;
    return;
  }

  const iconMap = {
    success: "fa-check", info: "fa-circle-info", warning: "fa-triangle-exclamation", danger: "fa-battery-quarter",
  };
  store.notifications.forEach((n) => {
    const div = document.createElement("div");
    div.className = "notif-item";
    div.innerHTML = `
      <div class="notif-icon ${n.type}"><i class="fas ${iconMap[n.type]}"></i></div>
      <div class="notif-info"><div class="n-text">${n.text}</div></div>
      <div class="notif-time">${n.time}</div>
    `;
    container.appendChild(div);
  });
}

// ---------------- Stats (all computed from real data, defaulting to 0) ----------------
function recalcStats() {
  const customers = store.customers;
  const collectorsList = store.collectors;

  $id("statTotalCustomers").textContent = customers.length;
  $id("statTotalCollectors").textContent = collectorsList.length;

  const collected = customers.filter((c) => c.status === "done").reduce((s, c) => s + (c.amount || 0), 0);
  const pending = customers.filter((c) => c.status !== "done").reduce((s, c) => s + (c.amount || 0), 0);
  const total = collected + pending;

  $id("statCollected").textContent = formatCurrency(collected);
  $id("statPending").textContent = formatCurrency(pending);
  $id("statTodayCollection").textContent = formatCurrency(collected);
  $id("collectionAmount").textContent = formatCurrency(collected);
  $id("pendingAmount").textContent = formatCurrency(pending);
  $id("totalCollectionsSum").textContent = formatCurrency(collected);

  const collectedPct = $id("statCollectedPct");
  const pendingPct = $id("statPendingPct");
  if (collectedPct) collectedPct.textContent = total ? `${Math.round((collected / total) * 100)}% of total` : "0% of total";
  if (pendingPct) pendingPct.textContent = total ? `${Math.round((pending / total) * 100)}% of total` : "0% of total";

  const doneCount = customers.filter((c) => c.status === "done").length;
  $id("avgCollection").textContent = doneCount ? formatCurrency(collected / doneCount) : "₹0";

  const online = collectorsList.filter((c) => c.online).length;
  $id("onlineCount").textContent = online;
  $id("offlineCount").textContent = collectorsList.length - online;

  updateNextStopCard();
}

// ---------------- Route builder actions ----------------
async function flushDraftCustomers(createdRemotely) {
  const drafts = store.customers.filter((c) => c.draft);
  if (!drafts.length) return;

  for (const draft of drafts) {
    if (!createdRemotely) {
      // Backend unreachable when the route itself was created — keep these
      // as local-only customers instead of retrying a call we know will fail.
      draft.draft = false;
      continue;
    }
    try {
      const payload = {
        name: draft.name,
        phone: draft.phone,
        default_amount: draft.amount,
        latitude: draft.lat,
        longitude: draft.lng,
      };
      const saved = await api(`/routes/${currentRoute.id}/customers`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      draft.id = saved.id;
      draft.sequence = saved.sequence;
      draft.draft = false;
    } catch (e) {
      draft.draft = false;
      addNotification("warning", `Couldn't save ${draft.name} to the server: ${e.message}`);
    }
  }
}

async function createRoute() {
  const routeName = $id("routeName").value.trim();

  if (currentRoute) {
    try {
      await api(`/routes/${currentRoute.id}/optimize`, { method: "POST" });
      addNotification("success", `Route "${currentRoute.name || currentRoute.route_name || ""}" optimized`);
      await loadCustomers();
    } catch (e) {
      alert(`Couldn't optimize route: ${e.message}`);
    }
    return;
  }

  if (!routeName) { $id("routeName").focus(); return; }

  const routeTypeInput = document.querySelector('input[name="routeType"]:checked');
  const routeType = routeTypeInput ? routeTypeInput.value : "today";
  const collectorId = getSelectedAssignCollectorId();

  const start = startMarker ? startMarker.getLatLng() : null;
  const end = endMarker ? endMarker.getLatLng() : null;
  if (!start || !end) {
    alert("Click the map to set both a start point and an end point.");
    return;
  }

  let createdRemotely = false;
  try {
    currentRoute = await api("/routes", {
      method: "POST",
      body: JSON.stringify({
        route_name: routeName,
        start_lat: start?.lat, start_lng: start?.lng,
        end_lat: end?.lat, end_lng: end?.lng,
      }),
    });
    usingLocalStore = false;
    createdRemotely = true;
  } catch (e) {
    if (!isNetworkError(e)) {
      alert(`Couldn't create route: ${e.message}`);
      return;
    }
    usingLocalStore = true;
    currentRoute = { id: Date.now() };
  }

  currentRoute.name = routeName;
  currentRoute.type = routeType;
  setRouteActionMode(true);

  let assigned = false;
  if (collectorId && createdRemotely) {
    try {
      if (routeType === "permanent") {
        await api(`/routes/${currentRoute.id}/default-collector`, {
          method: "PUT",
          body: JSON.stringify({ collector_id: collectorId }),
        });
      } else {
        await api("/collectors/assignments", {
          method: "POST",
          body: JSON.stringify({ route_id: currentRoute.id, collector_id: collectorId }),
        });
      }
      assigned = true;
    } catch (e) {
      alert(`Route was created, but couldn't assign the collector: ${e.message}`);
    }
  }

  const assignedNote = assigned
    ? ` and assigned to ${collectorNameById(collectorId)} (${routeType === "permanent" ? "Permanent" : "Today Only"})`
    : collectorId
      ? " - collector assignment was not completed"
      : " - no collector selected, so it is unassigned";
  addNotification("info", `Route "${routeName}" created${assignedNote}`);

  await flushDraftCustomers(createdRemotely);

  await loadRoutes();
  await loadCustomers();
}

function clearRoute() {
   clearLiveMarker();
  selectedCollectorId = null;
  if (startMarker) { map.removeLayer(startMarker); startMarker = null; }
  if (endMarker) { map.removeLayer(endMarker); endMarker = null; }
  $id("startLabel").value = "";
  $id("endLabel").value = "";
  currentRoute = null;
  setRouteActionMode(false);
  mode = "set-start";
  syncMapMarkers();
}

// ---------------- Customer / Collector modals ----------------
function openCustomerModal(lat, lng) {
  editingCustomerId = null;
  $id("customerModalTitle").textContent = "Add Customer";
  ["custName", "custPhone", "custAddress", "custAmount", "custSequence", "custImage"]
    .forEach((id) => { $id(id).value = ""; });
  $id("custLat").value = lat != null ? lat.toFixed(6) : "";
  $id("custLng").value = lng != null ? lng.toFixed(6) : "";
  $id("custLat").readOnly = true;
  $id("custLng").readOnly = true;
  $id("custActive").checked = true;
  if ($id("custPermanent")) $id("custPermanent").checked = false;
  $id("customerModal").style.display = "flex";
}

// Opens the same modal pre-filled for an existing customer, in edit mode.
// Lat/Lng become editable text fields here (rather than map-click-only)
// since the point already exists and may just need a small correction.
function openEditCustomerModal(id) {
  const c = store.customers.find((cust) => cust.id == id);
  if (!c) return;
  editingCustomerId = c.id;
  $id("customerModalTitle").textContent = "Edit Customer";
  $id("custName").value = c.name || "";
  $id("custPhone").value = c.phone || "";
  $id("custAddress").value = c.address || "";
  $id("custLat").value = c.lat != null ? c.lat.toFixed(6) : "";
  $id("custLng").value = c.lng != null ? c.lng.toFixed(6) : "";
  $id("custLat").readOnly = false;
  $id("custLng").readOnly = false;
  $id("custAmount").value = c.amount ?? "";
  $id("custSequence").value = c.sequence ?? "";
  $id("custImage").value = "";
  $id("custActive").checked = true;
  if ($id("custPermanent")) $id("custPermanent").checked = !!c.permanent;
  $id("customerModal").style.display = "flex";
}async function addCustomerFromModal() {
  const name = $id("custName").value.trim();
  if (!name) { $id("custName").focus(); return; }

  const phone = $id("custPhone").value.trim();
  const address = $id("custAddress").value.trim();
  const amount = parseFloat($id("custAmount").value) || 0;
  const lat = parseFloat($id("custLat").value);
  const lng = parseFloat($id("custLng").value);
  const sequence = parseInt($id("custSequence").value, 10) || (store.customers.length + 1);
  const permanent = $id("custPermanent") ? $id("custPermanent").checked : false;

  // Validate lat/lng
  if (isNaN(lat) || isNaN(lng)) {
    alert("Please enter valid latitude and longitude.");
    return;
  }

  // ---- Editing an existing customer ----
  if (editingCustomerId != null) {
    const existing = store.customers.find((c) => c.id == editingCustomerId);
    if (!existing) { editingCustomerId = null; $id("customerModal").style.display = "none"; return; }

    if (!existing.draft && !usingLocalStore) {
      try {
        const payload = { name, phone, default_amount: amount, latitude: lat, longitude: lng };
        const saved = await api(`/customers/${editingCustomerId}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        existing.sequence = saved.sequence;
      } catch (e) {
        alert(`Couldn't save changes: ${e.message}`);
        return;
      }
    }

    existing.name = name;
    existing.phone = phone;
    existing.address = address;
    existing.amount = amount;
    existing.lat = lat;
    existing.lng = lng;
    existing.permanent = permanent;

    addNotification("info", `Customer updated: ${name}`);
    editingCustomerId = null;
    $id("customerModal").style.display = "none";
    renderCustomers(store.customers.filter((c) => !c.permanent));
    renderPermanentCustomers();
    syncMapMarkers();
    recalcStats();
    return;
  }

  // ---- Adding a new customer ----
  const customer = {
    id: currentRoute ? Date.now() : `draft-${Date.now()}`,
    name, phone, address, amount, sequence,
    status: "pending",
    permanent,
    lat, lng,
    draft: !currentRoute,
    addedAt: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }),
  };

  // No route yet — keep this customer locally. It's saved to the backend
  // automatically the moment "Create Route" is clicked (see flushDraftCustomers).
  if (!currentRoute) {
    store.customers.push(customer);
    addNotification("info", `${name} added — will be saved once the route is created`);
    $id("customerModal").style.display = "none";
    clearPendingCustomerMarker();
    renderCustomers(store.customers.filter((c) => !c.permanent));
    renderPermanentCustomers();
    syncMapMarkers();
    recalcStats();
    return;
  }

  try {
    const payload = {
      name,
      phone,
      default_amount: amount,
      latitude: lat,
      longitude: lng
    };
    const savedCustomer = await api(`/routes/${currentRoute.id}/customers`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    customer.id = savedCustomer.id;
    customer.sequence = savedCustomer.sequence;
    store.customers.push(customer);
    usingLocalStore = false;
  } catch (e) {
    if (!isNetworkError(e)) {
      alert(`Couldn't save customer: ${e.message}`);
      return;
    }
    usingLocalStore = true;
    store.customers.push(customer);
    console.warn("Customer saved locally only:", e.message);
    addNotification("warning", `Customer saved locally (backend error): ${e.message}`);
  }

  addNotification("info", `New customer added: ${name}${permanent ? " (Permanent)" : ""}`);
  $id("customerModal").style.display = "none";
  clearPendingCustomerMarker();
  await loadCustomers(); // refresh UI
}
// ---------------- Event bindings ----------------
document.addEventListener("DOMContentLoaded", () => {
  initMap();
  renderCustomers(store.customers.filter((c) => !c.permanent));
  renderPermanentCustomers();
  renderCollectors(store.collectors);
  renderRoutesList();
  renderTimeline();
  renderNotifications();
  syncMapMarkers();
  recalcStats();
  loadCollectors().then(loadRoutes);

  $id("createRouteBtn").addEventListener("click", createRoute);
  $id("clearRouteBtn").addEventListener("click", clearRoute);

  $id("addCustomerBtn").addEventListener("click", () => {
    mode = "add-customer";
    addNotification("info", "Click a location on the map to place the new customer.");
  });
  $id("customerForm").addEventListener("submit", (e) => { e.preventDefault(); addCustomerFromModal(); });
  $id("closeCustomerModal").addEventListener("click", () => {
    $id("customerModal").style.display = "none";
    clearPendingCustomerMarker();
    editingCustomerId = null;
  });
  $id("closeCustomerDetailsModal").addEventListener("click", () => {
    $id("customerDetailsModal").style.display = "none";
  });

  $id("addCollectorBtn").addEventListener("click", () => {
    $id("collectorModalTitle").textContent = "Add Collector";
    ["collName", "collPhone", "collPhoto", "collVehicle"].forEach((id) => { $id(id).value = ""; });
    $id("collStatus").value = "online";
    $id("collectorModal").style.display = "flex";
    
  });
  $id("closeCollectorModal").addEventListener("click", () => { $id("collectorModal").style.display = "none"; });
  $id("collectorForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $id("collName").value.trim();
    if (!name) { $id("collName").focus(); return; }
    const phone = $id("collPhone").value.trim();
    if (!phone) { $id("collPhone").focus(); return; }
    const vehicle = $id("collVehicle").value.trim();
    const online = $id("collStatus").value === "online";

    try {
      await api("/collectors", { method: "POST", body: JSON.stringify({ name, phone, vehicle, active: online }) });
    } catch (err) {
      if (!isNetworkError(err)) {
        alert(`Couldn't create collector: ${err.message}`);
        return;
      }
      usingLocalStore = true;
      store.collectors.push({ id: Date.now(), name, online, battery: 100, amount: 0, km: 0 });
    }

    addNotification("info", `New collector added: ${name}`);
    $id("collectorModal").style.display = "none";
    await loadCollectors();
  });

  // Event delegation for remove buttons across customers, permanent customers, collectors, and routes
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    const id = btn.getAttribute("data-id");
    if (action === "remove-customer") removeCustomer(id);
    else if (action === "view-customer") showCustomerDetails(id);
    else if (action === "edit-customer") openEditCustomerModal(id);
    else if (action === "remove-collector") removeCollector(id);
    else if (action === "remove-route") removeRoute(id);
    else if (action === "assign-today-route") assignRouteToday(Number(id));
    else if (action === "assign-permanent-route") makeRoutePermanent(Number(id));
    else if (action === "clear-permanent-route") clearRoutePermanent(Number(id));
    else if (action === "edit-collector") {
      const c = store.collectors.find((c) => c.id == id);
      if (!c) return;
      editingCollectorId = c.id;
      $id("collectorModalTitle").textContent = "Edit Collector";
      $id("collName").value = c.name || "";
      $id("collPhone").value = c.phone || "";
      $id("collStatus").value = c.online ? "online" : "offline";
      $id("collectorModal").style.display = "flex";
    }
    // NEW: View route on map
    else if (action === "view-route-map") {
      viewRouteOnMap(Number(id));
    }
  });

  $id("sidebarToggle").addEventListener("click", () => {
    $id("sidebar").classList.toggle("collapsed");
    setTimeout(() => map.invalidateSize(), 220);
  });

  // On mobile the sidebar is an off-canvas drawer: tapping the backdrop
  // or picking a nav link closes it again. Harmless no-op on desktop.
  const sidebarOverlay = $id("sidebarOverlay");
  if (sidebarOverlay) {
    sidebarOverlay.addEventListener("click", () => {
      $id("sidebar").classList.remove("collapsed");
      setTimeout(() => map.invalidateSize(), 220);
    });
  }
  document.querySelectorAll(".sidebar-nav a").forEach((link) => {
    link.addEventListener("click", () => {
      if (window.innerWidth <= 768) {
        $id("sidebar").classList.remove("collapsed");
        setTimeout(() => map.invalidateSize(), 220);
      }
    });
  });

  $id("fullscreenBtn").addEventListener("click", () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    else document.exitFullscreen();
  });

const navSectionMap = {
  "dashboard": "section-dashboard",
  "route-builder": "section-route-builder",
  "saved-routes": "section-saved-routes",
  "customers": "section-customers",
  "collectors": "section-collectors",
  "tracking": "section-tracking",
  "notifications": "section-notifications",
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
        addNotification("info", `"${a.textContent.trim()}" page isn't built yet.`);
      }
    });
  });
});