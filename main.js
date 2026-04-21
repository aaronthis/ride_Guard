/**
 * main.js — RideGuard Web Companion entry point.
 *
 * Orchestrates all modules:
 *  - BLE connection and telemetry routing
 *  - Emergency system lifecycle
 *  - Map and GPS updates
 *  - Ride session management
 *  - Simulation mode (when no BLE device is connected)
 *  - UI wiring for top-level controls
 *
 * Architecture: Event-driven. Modules expose callbacks that main.js
 * populates to route data between modules without tight coupling.
 */

import * as ble       from './modules/ble.js';
import * as telemetry from './modules/telemetry.js';
import * as emergency from './modules/emergency.js';
import * as mapModule from './modules/map.js';
import * as storage   from './modules/storage.js';
import * as logger    from './modules/logger.js';
import * as toast     from './modules/toast.js';

// ── Simulation mode state ─────────────────────────────────────
let simInterval     = null;  // setInterval handle for demo data feed
const SIM_INTERVAL  = 200;   // ms between simulated telemetry packets
let simActive       = false;

// ── Ride session state ─────────────────────────────────────────
let rideActive      = false;
let rideStartTime   = null;
let rideHasIncident = false;
let rideSpeedSamples = [];

// ── App init ──────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  logger.sys('RideGuard Web Companion v1.0.0 starting…');
  logger.sys(`Browser: ${navigator.userAgent.split(' ').pop()}`);
  logger.sys(`Web Bluetooth supported: ${ble.isSupported()}`);

  // Check Web Bluetooth support and show banner if missing
  if (!ble.isSupported()) {
    document.getElementById('ble-unsupported-banner')?.classList.remove('hidden');
    logger.sys('Web Bluetooth unavailable — simulation mode auto-enabled.');
  }

  // Initialize subsystems
  logger.initSerialMonitorUI();
  await storage.initStorage();
  await storage.renderRideHistory();

  // Initialize Leaflet map (waits for Leaflet script to load)
  waitForLeaflet(() => mapModule.initMap());

  // Wire up module callbacks
  setupBLECallbacks();
  setupTelemetryCallbacks();
  setupEmergencyCallbacks();

  // Wire up all DOM controls
  setupBLEControls();
  setupRideControls();
  emergency.initEmergencyUI();

  // High-G injection event (from emergency.js)
  document.addEventListener('rideguard:inject-high-g', handleHighGInjection);

  // Start demo simulation mode after 1s if no BLE
  setTimeout(() => {
    if (!ble.isConnected()) {
      startSimulationMode();
    }
  }, 1000);

  logger.sys('All systems initialized. Ready.');
});

// ═══════════════════════════════════════════════════════════════
// BLE CALLBACKS
// ═══════════════════════════════════════════════════════════════

function setupBLECallbacks() {
  // Route BLE telemetry to telemetry module
  ble.onTelemetry = (data) => {
    // Stop simulation when real data arrives
    if (simActive) stopSimulationMode();
    telemetry.processTelemetry(data);
  };

  // Emergency alert from helmet's dedicated characteristic
  ble.onEmergencyAlert = () => {
    logger.fall('⚠ Emergency alert from helmet BLE characteristic!');
    emergency.triggerEmergency({
      source: 'HELMET_BLE',
      gForce: telemetry.getSessionMaxG()
    });
  };

  // Connection state changes
  ble.onConnectionChange = (state) => {
    updateBLEStatusUI(state);

    switch (state) {
      case 'connected':
        stopSimulationMode();
        toast.success(`Connected to ${ble.getDeviceName() || 'Helmet'}`);
        logger.ble(`✓ BLE connected to: ${ble.getDeviceName()}`);
        break;

      case 'disconnected':
        toast.warning('Helmet disconnected');
        // Resume simulation mode while waiting for reconnect
        if (!simActive) startSimulationMode();
        break;

      case 'reconnecting':
        toast.info('Reconnecting to helmet…', 0);
        break;

      case 'error':
        toast.error('BLE connection failed — check browser support');
        startSimulationMode();
        break;
    }
  };

  // Raw packet log (goes to serial monitor via logger.ble in ble.js)
  ble.onRawPacket = (_raw) => {
    // Already logged in ble.js — no additional action needed here
  };
}

// ═══════════════════════════════════════════════════════════════
// TELEMETRY CALLBACKS
// ═══════════════════════════════════════════════════════════════

function setupTelemetryCallbacks() {
  // Fall detection from telemetry threshold crossing
  telemetry.onFallDetected = ({ source, at, lat, lon }) => {
    if (!rideActive) return; // Don't trigger emergency unless riding

    logger.fall(`⚠ Fall detection! Source: ${source}, AT=${at.toFixed(3)}g`);
    emergency.triggerEmergency({ source, gForce: at, lat, lon });

    rideHasIncident = true;
  };

  // Every telemetry update — used for ride logging
  telemetry.onTelemetryUpdate = ({ lat, lon, spd }) => {
    // Update map with helmet position
    if (lat && lon && lat !== 0 && lon !== 0) {
      mapModule.updateHelmetPosition(lat, lon, spd);
    }

    // Track speed for average calculation during active ride
    if (rideActive && spd > 0) {
      rideSpeedSamples.push(spd);
      if (rideSpeedSamples.length > 2000) rideSpeedSamples.shift();
    }
  };
}

// ═══════════════════════════════════════════════════════════════
// EMERGENCY CALLBACKS
// ═══════════════════════════════════════════════════════════════

function setupEmergencyCallbacks() {
  emergency.onAlertSent = () => {
    rideHasIncident = true;
    toast.error('⚡ Alert SENT (simulated — no real SMS)', 6000);
    logger.emergency('Ride flagged with incident.');
  };

  emergency.onAlertCancelled = () => {
    toast.success('Alert cancelled — rider OK!');
  };
}

// ═══════════════════════════════════════════════════════════════
// BLE UI CONTROLS
// ═══════════════════════════════════════════════════════════════

function setupBLEControls() {
  document.getElementById('btn-connect')?.addEventListener('click', async () => {
    await ble.connect();
  });

  document.getElementById('btn-disconnect')?.addEventListener('click', () => {
    ble.disconnect();
    startSimulationMode();
  });
}

/**
 * Update the topbar BLE status indicator.
 * @param {'connected'|'disconnected'|'reconnecting'|'error'} state
 */
function updateBLEStatusUI(state) {
  const dot      = document.getElementById('ble-dot');
  const label    = document.getElementById('ble-label');
  const btnConn  = document.getElementById('btn-connect');
  const btnDisc  = document.getElementById('btn-disconnect');

  const states = {
    connected:    { dotClass: 'connected',    text: `Connected: ${ble.getDeviceName() || 'Helmet'}` },
    disconnected: { dotClass: '',             text: 'Disconnected' },
    reconnecting: { dotClass: 'reconnecting', text: 'Reconnecting…' },
    error:        { dotClass: '',             text: 'Connection Error' }
  };

  const s = states[state] || states.disconnected;

  if (dot)   { dot.className = `ble-dot ${s.dotClass}`; }
  if (label) { label.textContent = s.text; }

  const isConn = state === 'connected';
  btnConn?.classList.toggle('hidden', isConn);
  btnDisc?.classList.toggle('hidden', !isConn);
}

// ═══════════════════════════════════════════════════════════════
// RIDE CONTROLS
// ═══════════════════════════════════════════════════════════════

function setupRideControls() {
  const btnToggle = document.getElementById('btn-toggle-ride');
  const btnClear  = document.getElementById('btn-clear-history');

  btnToggle?.addEventListener('click', () => {
    if (rideActive) {
      stopRide();
    } else {
      startRide();
    }
  });

  btnClear?.addEventListener('click', async () => {
    if (!confirm('Clear all ride history? This cannot be undone.')) return;
    await storage.clearAllRides();
    await storage.renderRideHistory();
    toast.info('Ride history cleared.');
  });
}

/**
 * Begin a new ride session.
 */
function startRide() {
  rideActive      = true;
  rideStartTime   = Date.now();
  rideHasIncident = false;
  rideSpeedSamples = [];
  telemetry.resetSession();
  mapModule.clearRoute();

  const badge  = document.getElementById('ride-badge');
  const btn    = document.getElementById('btn-toggle-ride');
  if (badge) { badge.textContent = '● Ride Active'; badge.className = 'ride-badge active'; }
  if (btn)   { btn.textContent = 'End Ride'; btn.className = 'btn btn--accent stop btn--sm'; }

  logger.sys(`Ride started at ${new Date(rideStartTime).toLocaleTimeString()}`);
  toast.success('Ride started — logging telemetry.');
}

/**
 * End the current ride session and save to storage.
 */
async function stopRide() {
  if (!rideActive) return;
  rideActive = false;

  const endTime   = Date.now();
  const route     = mapModule.getRouteSnapshot();
  const distKm    = storage.calculateDistance(route);
  const maxG      = telemetry.getSessionMaxG();
  const avgSpeed  = rideSpeedSamples.length > 0
    ? rideSpeedSamples.reduce((a, b) => a + b, 0) / rideSpeedSamples.length
    : 0;

  const session = {
    startTime:   rideStartTime,
    endTime:     endTime,
    distanceKm:  distKm,
    maxGForce:   maxG,
    route:       route.map(c => ({ lat: c[0], lng: c[1] })),
    incident:    rideHasIncident,
    avgSpeedKmh: avgSpeed
  };

  await storage.saveRide(session);
  await storage.renderRideHistory();

  const badge = document.getElementById('ride-badge');
  const btn   = document.getElementById('btn-toggle-ride');
  if (badge) { badge.textContent = '● Ride Idle'; badge.className = 'ride-badge'; }
  if (btn)   { btn.textContent = 'Start Ride'; btn.className = 'btn btn--accent btn--sm'; }

  const dur = Math.round((endTime - rideStartTime) / 60000);
  logger.sys(`Ride ended — ${distKm.toFixed(2)}km | ${dur}min | maxG=${maxG.toFixed(2)} | incident=${rideHasIncident}`);
  toast.success(`Ride saved: ${distKm.toFixed(1)} km, max ${maxG.toFixed(2)}g`);
}

// ═══════════════════════════════════════════════════════════════
// HIGH-G INJECTION (DEBUG)
// ═══════════════════════════════════════════════════════════════

/**
 * Inject a simulated high-G spike for testing fall detection.
 * Sends a packet with G-force above FALL_THRESHOLD.
 */
function handleHighGInjection() {
  const g = 4.5 + Math.random() * 2; // 4.5–6.5g
  logger.sys(`[DBG] Injecting high-G pulse: ${g.toFixed(2)}g`);

  // Inject telemetry with fall values
  telemetry.injectSimulatedTelemetry({
    at:   g,
    ax:   g * 0.7,
    ay:   g * 0.5,
    az:   g * 0.3,
    fall: false // Let threshold detection handle it
  });

  toast.warning(`High-G injected: ${g.toFixed(2)}g`);
}

// ═══════════════════════════════════════════════════════════════
// SIMULATION MODE
// Generates realistic-looking telemetry when no BLE is connected.
// Helps developers test the UI without hardware.
// ═══════════════════════════════════════════════════════════════

let simTime = 0; // Elapsed sim ticks

function startSimulationMode() {
  if (simActive) return;
  simActive = true;
  simTime = 0;
  logger.sys('[SIM] Simulation mode active — generating fake telemetry.');
  logger.sys('[SIM] Connect a real BLE device to switch to live data.');

  simInterval = setInterval(() => {
    simTime++;
    const packet = generateSimPacket();
    telemetry.processTelemetry(packet);

    // Occasionally move map GPS in sim mode
    if (simTime % 10 === 0) {
      mapModule.simulateGPSMovement();
    }
  }, SIM_INTERVAL);
}

function stopSimulationMode() {
  if (!simActive) return;
  simActive = false;
  clearInterval(simInterval);
  simInterval = null;
  logger.sys('[SIM] Simulation mode stopped — using live BLE data.');
}

/**
 * Generate a realistic simulated telemetry packet.
 * Simulates a motorcycle riding with occasional vibration.
 */
function generateSimPacket() {
  const t    = simTime * SIM_INTERVAL / 1000; // Elapsed seconds
  const ride = Math.sin(t * 0.3);             // Slow ride oscillation

  // Base values: slight vibration + road bump simulation
  const ax = (Math.random() - 0.5) * 0.15 + Math.sin(t * 7) * 0.05;
  const ay = (Math.random() - 0.5) * 0.12 + Math.cos(t * 5) * 0.04;
  const az = 1.0 + (Math.random() - 0.5) * 0.1 + ride * 0.08;
  const at = Math.sqrt(ax*ax + ay*ay + az*az);

  const gx = (Math.random() - 0.5) * 8 + Math.sin(t * 2) * 3;
  const gy = (Math.random() - 0.5) * 6 + Math.cos(t * 3) * 2;
  const gz = (Math.random() - 0.5) * 4;

  // Simulated GPS (slowly drifting)
  const lat  = 14.5995 + Math.sin(t * 0.05) * 0.003;
  const lon  = 120.9842 + Math.cos(t * 0.04) * 0.003;
  const spd  = 40 + Math.sin(t * 0.2) * 15;

  // Fake NMEA string
  const nmea = `$GPGGA,${formatNMEATime()},1459.970,N,12059.052,E,1,07,1.2,${(25 + Math.random()).toFixed(1)},M,,M,,*XX`;

  return {
    ax: parseFloat(ax.toFixed(4)),
    ay: parseFloat(ay.toFixed(4)),
    az: parseFloat(az.toFixed(4)),
    at: parseFloat(at.toFixed(4)),
    gx: parseFloat(gx.toFixed(2)),
    gy: parseFloat(gy.toFixed(2)),
    gz: parseFloat(gz.toFixed(2)),
    lat: parseFloat(lat.toFixed(6)),
    lon: parseFloat(lon.toFixed(6)),
    spd: parseFloat(spd.toFixed(1)),
    fix: 1,
    sat: 7 + Math.floor(Math.random() * 3),
    bat: Math.max(20, 82 - Math.floor(simTime / 100)),
    vlt: 3.85,
    chg: false,
    fall: false,
    nmea
  };
}

/** Format current time as HHMMSS.00 for NMEA */
function formatNMEATime() {
  const now = new Date();
  return String(now.getUTCHours()).padStart(2, '0') +
         String(now.getUTCMinutes()).padStart(2, '0') +
         String(now.getUTCSeconds()).padStart(2, '0') + '.00';
}

// ═══════════════════════════════════════════════════════════════
// LEAFLET READY HELPER
// Leaflet loads asynchronously — wait for window.L to exist.
// ═══════════════════════════════════════════════════════════════

function waitForLeaflet(callback, attempts = 0) {
  if (window.L) {
    callback();
  } else if (attempts < 20) {
    setTimeout(() => waitForLeaflet(callback, attempts + 1), 200);
  } else {
    logger.err('Leaflet failed to load — map unavailable.');
  }
}

// ═══════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════

window.addEventListener('beforeunload', () => {
  if (rideActive) {
    // Best-effort save on page close
    stopRide();
  }
  mapModule.destroy();
  ble.disconnect();
});
