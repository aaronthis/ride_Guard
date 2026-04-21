/**
 * telemetry.js — Telemetry data processing and live UI updates.
 *
 * Receives parsed telemetry objects from ble.js (or simulator).
 * Updates all dashboard widgets: G-force gauge, axis bars, GPS fields.
 * Tracks per-session stats (max G, fall events).
 * Fires callbacks when thresholds are crossed.
 */

import * as logger from './logger.js';

// ── Thresholds ────────────────────────────────────────────────
const FALL_THRESHOLD_G   = 4.0;   // Definitive fall
const HIGH_RISK_G        = 2.5;   // High impact
const MEDIUM_RISK_G      = 1.5;   // Notable impact
const STALE_THRESHOLD_MS = 5000;  // Consider data stale after 5s

// ── Session state ─────────────────────────────────────────────
let sessionMaxG    = 0;
let lastDataTime   = 0;
let staleTimer     = null;
let isStale        = false;

// ── Callbacks ─────────────────────────────────────────────────
export let onFallDetected    = null;  // Called when fall threshold crossed
export let onTelemetryUpdate = null;  // Called with every processed packet

// ── Gauge Arc setup ───────────────────────────────────────────
// The gauge arc represents 0–6g over a 180° sweep (pi × r = pi × 80 ≈ 251px)
const GAUGE_MAX_G   = 6;
const ARC_FULL_LEN  = 251;  // Circumference of semicircle (πr, r=80)

/**
 * Process a raw telemetry data object and update all UI elements.
 * This is the main entry point called by ble.js or the simulator.
 *
 * @param {Object} data - Parsed telemetry from ESP32 JSON packet
 */
export function processTelemetry(data) {
  lastDataTime = Date.now();
  isStale = false;
  resetStaleTimer();

  // Extract values with safe defaults
  const ax = data.ax ?? 0;
  const ay = data.ay ?? 0;
  const az = data.az ?? 1;
  const gx = data.gx ?? 0;
  const gy = data.gy ?? 0;
  const gz = data.gz ?? 0;
  const at = data.at ?? Math.sqrt(ax*ax + ay*ay + az*az); // Compute if not provided
  const lat  = data.lat ?? null;
  const lon  = data.lon ?? null;
  const spd  = data.spd ?? 0;
  const fix  = data.fix ?? 0;
  const sat  = data.sat ?? 0;
  const fall = data.fall === true;

  // Update G-force display
  updateGForceDisplay(at);

  // Update axis bars (accelerometer + gyroscope)
  updateAxisBars({ ax, ay, az, gx, gy, gz });

  // Update GPS fields
  updateGPSDisplay({ lat, lon, spd, fix, sat });

  // Check for fall detection flag from firmware
  if (fall && onFallDetected) {
    logger.fall(`Fall flag received in telemetry! AT=${at.toFixed(3)}g`);
    onFallDetected({ source: 'BLE_HELMET', at, lat, lon });
  }

  // Check thresholds independently (secondary detection)
  if (at >= FALL_THRESHOLD_G && !fall && onFallDetected) {
    logger.fall(`Phone-side fall threshold exceeded! AT=${at.toFixed(3)}g >= ${FALL_THRESHOLD_G}g`);
    onFallDetected({ source: 'PHONE_THRESHOLD', at, lat, lon });
  }

  // Fire generic update callback (used by storage.js for route logging)
  if (onTelemetryUpdate) onTelemetryUpdate({ ax, ay, az, gx, gy, gz, at, lat, lon, spd, fix, sat, fall });
}

/**
 * Update the G-force gauge arc, numeric value, and risk badge.
 */
function updateGForceDisplay(at) {
  // Clamp for gauge display
  const clamped = Math.min(at, GAUGE_MAX_G);
  const fraction = clamped / GAUGE_MAX_G;
  const arcLen = fraction * ARC_FULL_LEN;

  // Update SVG arc
  const arc = document.getElementById('gauge-arc');
  if (arc) {
    arc.style.strokeDasharray = `${arcLen} ${ARC_FULL_LEN}`;
    arc.style.stroke = riskColor(at);
  }

  // Update numeric display
  const numEl = document.getElementById('gforce-num');
  if (numEl) {
    numEl.textContent = at.toFixed(2);
    numEl.style.color = riskColor(at);
  }

  // Update session max
  if (at > sessionMaxG) {
    sessionMaxG = at;
    const maxEl = document.getElementById('session-max-g');
    if (maxEl) maxEl.textContent = `${sessionMaxG.toFixed(2)}g`;
  }

  // Update risk badge
  const badge = document.getElementById('risk-badge');
  if (badge) {
    if (at >= FALL_THRESHOLD_G) {
      badge.textContent  = 'FALL';
      badge.className    = 'risk-badge danger';
    } else if (at >= HIGH_RISK_G) {
      badge.textContent  = 'DANGER';
      badge.className    = 'risk-badge danger';
    } else if (at >= MEDIUM_RISK_G) {
      badge.textContent  = 'WARNING';
      badge.className    = 'risk-badge warning';
    } else {
      badge.textContent  = 'SAFE';
      badge.className    = 'risk-badge';
    }
  }

  // Update fall indicator
  const fallIndicator = document.getElementById('fall-flag-indicator');
  if (fallIndicator) {
    if (at >= FALL_THRESHOLD_G) {
      fallIndicator.innerHTML = 'Fall: <strong class="danger">⚠ YES</strong>';
    } else {
      fallIndicator.innerHTML = 'Fall: <strong class="safe">None</strong>';
    }
  }
}

/**
 * Update the axis bar visualizations.
 * Bars extend left (negative) or right (positive) from center.
 * Max range: ±4g for accel, ±360°/s for gyro.
 */
function updateAxisBars({ ax, ay, az, gx, gy, gz }) {
  // Accelerometer bars (±4g range)
  setAxisBar('ax', ax, 4, 'val-ax', 'bar-ax');
  setAxisBar('ay', ay, 4, 'val-ay', 'bar-ay');
  setAxisBar('az', az, 4, 'val-az', 'bar-az');

  // Gyro bars (±360 °/s range)
  setAxisBar('gx', gx, 360, 'val-gx', 'bar-gx');
  setAxisBar('gy', gy, 360, 'val-gy', 'bar-gy');
  setAxisBar('gz', gz, 360, 'val-gz', 'bar-gz');
}

/**
 * Update a single axis bar and value label.
 * @param {string} _id  - unused axis ID (kept for symmetry)
 * @param {number} value - the raw value
 * @param {number} range - ±max range for normalizing bar width
 * @param {string} valId - DOM id for the value span
 * @param {string} barId - DOM id for the bar div
 */
function setAxisBar(_id, value, range, valId, barId) {
  const valEl = document.getElementById(valId);
  const barEl = document.getElementById(barId);

  if (valEl) {
    valEl.textContent = (value >= 0 ? '+' : '') + value.toFixed(range >= 100 ? 1 : 3);
  }

  if (barEl) {
    // Normalize to 0–50% width (50% = full range), centered at 50%
    const pct     = Math.min(Math.abs(value) / range, 1) * 50;
    const isNeg   = value < 0;

    // For positive values: left=50%, width=pct
    // For negative values: left=(50-pct)%, width=pct
    barEl.style.width = `${pct}%`;
    barEl.style.left  = isNeg ? `${50 - pct}%` : '50%';
  }
}

/**
 * Update GPS display fields.
 */
function updateGPSDisplay({ lat, lon, spd, fix, sat }) {
  const fields = {
    'gps-lat':   lat != null && lat !== 0 ? lat.toFixed(6) + '°N' : '—',
    'gps-lon':   lon != null && lon !== 0 ? lon.toFixed(6) + '°E' : '—',
    'gps-speed': spd != null ? `${spd.toFixed(1)} km/h` : '— km/h',
    'gps-fix':   fixLabel(fix, sat)
  };

  Object.entries(fields).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  });
}

function fixLabel(fix, sat) {
  const labels = { 0: 'No Fix', 1: 'GPS Fix', 2: 'DGPS' };
  const label = labels[fix] || 'Unknown';
  return sat > 0 ? `${label} (${sat} sat)` : label;
}

/**
 * Map a G-force value to a CSS color.
 */
function riskColor(at) {
  if (at >= FALL_THRESHOLD_G) return '#FF1744';
  if (at >= HIGH_RISK_G)      return '#FF8800';
  if (at >= MEDIUM_RISK_G)    return '#FFD600';
  return '#4FC3F7';
}

/**
 * Reset the stale-data timer.
 * If no data arrives within STALE_THRESHOLD_MS, mark display as stale.
 */
function resetStaleTimer() {
  clearTimeout(staleTimer);
  staleTimer = setTimeout(() => {
    isStale = true;
    // Dim the G-force number to signal stale data
    const numEl = document.getElementById('gforce-num');
    if (numEl) numEl.style.opacity = '0.4';
  }, STALE_THRESHOLD_MS);
}

/**
 * Reset session statistics (call when starting a new ride).
 */
export function resetSession() {
  sessionMaxG = 0;
  const maxEl = document.getElementById('session-max-g');
  if (maxEl) maxEl.textContent = '0.00g';

  // Reset G-force display
  const numEl = document.getElementById('gforce-num');
  if (numEl) { numEl.textContent = '0.00'; numEl.style.opacity = '1'; }

  const arc = document.getElementById('gauge-arc');
  if (arc) arc.style.strokeDasharray = `0 ${ARC_FULL_LEN}`;

  const badge = document.getElementById('risk-badge');
  if (badge) { badge.textContent = 'SAFE'; badge.className = 'risk-badge'; }
}

/**
 * Get current session max G (used by storage.js when saving ride).
 */
export function getSessionMaxG() {
  return sessionMaxG;
}

/**
 * Inject a simulated telemetry packet for testing.
 * @param {Object} overrides - Override specific fields (e.g. {at: 5.2, fall: true})
 */
export function injectSimulatedTelemetry(overrides = {}) {
  const base = {
    ax: (Math.random() - 0.5) * 0.2,
    ay: (Math.random() - 0.5) * 0.2,
    az: 1 + (Math.random() - 0.5) * 0.1,
    gx: (Math.random() - 0.5) * 5,
    gy: (Math.random() - 0.5) * 5,
    gz: (Math.random() - 0.5) * 5,
    at: 1.0 + Math.random() * 0.2,
    lat: 14.5995 + (Math.random() - 0.5) * 0.001,
    lon: 120.9842 + (Math.random() - 0.5) * 0.001,
    spd: 45 + (Math.random() - 0.5) * 5,
    fix: 1,
    sat: 7 + Math.floor(Math.random() * 3),
    bat: 82,
    fall: false
  };

  const packet = { ...base, ...overrides };
  // Recalculate at if axes were overridden but not at
  if (!overrides.at) {
    packet.at = Math.sqrt(packet.ax**2 + packet.ay**2 + packet.az**2);
  }

  logger.mpu(`[SIM] Injected: at=${packet.at.toFixed(3)}g ax=${packet.ax.toFixed(3)} ay=${packet.ay.toFixed(3)} az=${packet.az.toFixed(3)}`);
  processTelemetry(packet);
  return packet;
}
