/**
 * map.js — Leaflet.js map integration.
 *
 * Manages:
 *  - Map initialization with dark tile layer
 *  - Helmet GPS marker (from BLE telemetry)
 *  - Browser (user) GPS marker
 *  - Route polyline history
 *  - Graceful no-signal handling
 *
 * Leaflet is loaded via CDN in index.html (window.L global).
 */

import * as logger from './logger.js';

// ── Map state ─────────────────────────────────────────────────
let map              = null;
let helmetMarker     = null;
let phoneMarker      = null;
let routePolyline    = null;
let routeCoords      = [];    // Array of [lat, lng] for the route
let phonePosWatcher  = null;  // Geolocation watchPosition ID
let mapInitialized   = false;

// ── Map config ────────────────────────────────────────────────
const DEFAULT_CENTER = [14.5995, 120.9842]; // Manila, Philippines
const DEFAULT_ZOOM   = 14;
const MAX_ROUTE_PTS  = 5000; // Max route points before oldest are pruned

/**
 * Initialize the Leaflet map in #map-container.
 * Must be called after Leaflet script has loaded (after DOMContentLoaded).
 */
export function initMap() {
  if (mapInitialized) return;
  if (!window.L) {
    logger.err('Leaflet not loaded — map unavailable.');
    return;
  }

  const container = document.getElementById('map-container');
  if (!container) return;

  // Create map
  map = window.L.map('map-container', {
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    zoomControl: true,
    attributionControl: true
  });

  // Dark tile layer (CartoDB Dark Matter)
  window.L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    {
      attribution: '© OpenStreetMap contributors © CartoDB',
      subdomains: 'abcd',
      maxZoom: 19
    }
  ).addTo(map);

  // Custom marker icons
  helmetMarker = window.L.marker(DEFAULT_CENTER, {
    icon: createCustomIcon('#4FC3F7', '⬟'),
    title: 'Helmet GPS'
  }).addTo(map);
  helmetMarker.bindPopup('<b>Helmet GPS</b><br>NEO-M6 Module');

  // Empty route polyline
  routePolyline = window.L.polyline([], {
    color: '#FF8800',
    weight: 3,
    opacity: 0.8,
    dashArray: null
  }).addTo(map);

  mapInitialized = true;
  logger.sys('Map initialized. Starting browser GPS…');

  // Start browser geolocation
  startPhoneGPS();

  // Wire up map control buttons
  document.getElementById('btn-center-map')?.addEventListener('click', centerOnHelmet);
  document.getElementById('btn-clear-route')?.addEventListener('click', clearRoute);
}

/**
 * Create a custom colored div icon for Leaflet markers.
 */
function createCustomIcon(color, symbol) {
  return window.L.divIcon({
    className: '',
    html: `<div style="
      width: 28px; height: 28px;
      background: ${color};
      border: 2px solid rgba(255,255,255,0.8);
      border-radius: 50% 50% 50% 0;
      transform: rotate(-45deg);
      box-shadow: 0 2px 8px rgba(0,0,0,0.5);
      display: flex; align-items: center; justify-content: center;
    "></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 28],
    popupAnchor: [0, -28]
  });
}

/**
 * Update the helmet GPS marker position from telemetry.
 * @param {number} lat
 * @param {number} lon
 * @param {number} speed - km/h
 */
export function updateHelmetPosition(lat, lon, speed = 0) {
  if (!mapInitialized || !map) return;
  if (!lat || !lon || lat === 0 || lon === 0) return;

  const latlng = [lat, lon];

  // Move marker
  helmetMarker.setLatLng(latlng);
  helmetMarker.setPopupContent(
    `<b>Helmet GPS</b><br>
     Lat: ${lat.toFixed(6)}<br>
     Lon: ${lon.toFixed(6)}<br>
     Speed: ${speed.toFixed(1)} km/h`
  );

  // Add to route
  routeCoords.push(latlng);
  if (routeCoords.length > MAX_ROUTE_PTS) {
    routeCoords.shift(); // Remove oldest point
  }
  routePolyline.setLatLngs(routeCoords);

  // Log GPS position
  logger.gps(`Helmet: ${lat.toFixed(6)}, ${lon.toFixed(6)} @ ${speed.toFixed(1)} km/h`);
}

/**
 * Start watching browser's own GPS position.
 * Shows as a secondary "phone" marker on the map.
 */
function startPhoneGPS() {
  if (!navigator.geolocation) {
    logger.sys('Browser geolocation not available.');
    return;
  }

  phonePosWatcher = navigator.geolocation.watchPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;

      if (!phoneMarker) {
        // Create phone marker on first fix
        phoneMarker = window.L.marker([lat, lon], {
          icon: createCustomIcon('#FFD600', '●'),
          title: 'Your GPS',
          zIndexOffset: 1000
        }).addTo(map);
        phoneMarker.bindPopup('<b>Browser GPS</b><br>Your device position');

        // Center map on first phone fix if helmet hasn't given us a position
        if (routeCoords.length === 0) {
          map.setView([lat, lon], DEFAULT_ZOOM);
        }

        logger.sys(`Browser GPS fix obtained: ${lat.toFixed(5)}, ${lon.toFixed(5)}`);
      } else {
        phoneMarker.setLatLng([lat, lon]);
        phoneMarker.setPopupContent(
          `<b>Browser GPS</b><br>Lat: ${lat.toFixed(6)}<br>Lon: ${lon.toFixed(6)}<br>Accuracy: ±${Math.round(pos.coords.accuracy)}m`
        );
      }
    },
    (err) => {
      // Handle gracefully — map works without phone GPS
      if (err.code === 1) {
        logger.sys('Browser GPS: permission denied. Helmet-only map mode.');
      } else if (err.code === 2) {
        logger.sys('Browser GPS: position unavailable (no signal).');
      } else {
        logger.sys(`Browser GPS error: ${err.message}`);
      }
    },
    {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 15000
    }
  );
}

/**
 * Pan map to the current helmet position.
 */
function centerOnHelmet() {
  if (!mapInitialized || !map) return;

  const pos = helmetMarker?.getLatLng();
  if (pos && pos.lat !== DEFAULT_CENTER[0]) {
    map.setView([pos.lat, pos.lng], 16, { animate: true });
  } else if (phoneMarker) {
    map.setView(phoneMarker.getLatLng(), 16, { animate: true });
  } else {
    logger.sys('No GPS position available to center on.');
  }
}

/**
 * Clear the route polyline from the map (keeps markers).
 */
export function clearRoute() {
  routeCoords = [];
  if (routePolyline) routePolyline.setLatLngs([]);
  logger.sys('Route cleared from map.');
}

/**
 * Get a copy of the current route coordinates.
 * Used by storage.js when saving a ride session.
 */
export function getRouteSnapshot() {
  return [...routeCoords];
}

/**
 * Stop browser GPS watching (call on page unload).
 */
export function destroy() {
  if (phonePosWatcher !== null) {
    navigator.geolocation?.clearWatch(phonePosWatcher);
    phonePosWatcher = null;
  }
}

/**
 * Add a simulated GPS point (for simulator mode with no real BLE).
 * Generates a small random walk from the last known position.
 */
export function simulateGPSMovement() {
  const last = routeCoords.length > 0
    ? routeCoords[routeCoords.length - 1]
    : DEFAULT_CENTER;

  const newLat = last[0] + (Math.random() - 0.5) * 0.0002;
  const newLon = last[1] + (Math.random() - 0.5) * 0.0002;

  updateHelmetPosition(newLat, newLon, 40 + Math.random() * 20);
}
