/**
 * emergency.js — Emergency alert simulation system.
 *
 * Manages the full emergency workflow:
 *   1. Trigger (from BLE fall flag, G-force threshold, or manual simulation)
 *   2. Full-screen overlay display
 *   3. Countdown timer (configurable seconds)
 *   4. Cancel path (user confirms they're OK)
 *   5. Alert-sent state (logs only — no real SMS in web companion)
 *
 * IMPORTANT: This is a SIMULATION tool only.
 * Real SMS dispatch is intentionally not implemented.
 * All "alerts" are logged locally.
 */

import * as logger from './logger.js';

// ── Config ────────────────────────────────────────────────────
const DEFAULT_COUNTDOWN = 10;    // Seconds before alert "sends"
const COOLDOWN_MS       = 15000; // Minimum ms between auto-triggers

// ── State ─────────────────────────────────────────────────────
let countdownTimer  = null;
let countdownValue  = DEFAULT_COUNTDOWN;
let isActive        = false;
let lastTriggerTime = 0;

// ── Callbacks ─────────────────────────────────────────────────
export let onAlertSent     = null;  // Called when countdown expires
export let onAlertCancelled = null; // Called when user cancels

/**
 * Trigger the emergency overlay.
 * @param {Object} opts
 * @param {string}  opts.source  - 'HELMET_BLE' | 'PHONE_THRESHOLD' | 'SIMULATOR' | 'HIGH_G_INJECT'
 * @param {number}  opts.gForce  - G-force at time of trigger
 * @param {number}  [opts.lat]   - Latitude for SMS template
 * @param {number}  [opts.lon]   - Longitude
 * @param {number}  [opts.countdown] - Override countdown seconds
 */
export function triggerEmergency({ source = 'SIMULATOR', gForce = 0, lat = null, lon = null, countdown = DEFAULT_COUNTDOWN } = {}) {
  // Cooldown guard (except for manual simulation)
  const now = Date.now();
  if (source !== 'SIMULATOR' && isActive) {
    logger.emergency(`Trigger ignored — already active. Source: ${source}`);
    return;
  }

  if (source !== 'SIMULATOR' && (now - lastTriggerTime) < COOLDOWN_MS) {
    logger.emergency(`Trigger ignored — cooldown active (${Math.round((COOLDOWN_MS - (now - lastTriggerTime)) / 1000)}s remaining). Source: ${source}`);
    return;
  }

  lastTriggerTime = now;
  isActive = true;
  countdownValue = countdown;

  logger.emergency(`🚨 EMERGENCY TRIGGERED | Source: ${source} | G-force: ${gForce.toFixed(2)}g`);
  if (lat && lon) {
    logger.emergency(`Location: ${lat.toFixed(6)}, ${lon.toFixed(6)}`);
    logger.emergency(`[SIM] SMS would be sent to contacts with map link: https://maps.google.com/?q=${lat.toFixed(6)},${lon.toFixed(6)}`);
  } else {
    logger.emergency('[SIM] No GPS fix — SMS would include "Location unknown"');
  }

  // Show overlay
  showOverlay(source, gForce, lat, lon);

  // Update emergency state indicator
  setStateDisplay('pending', 'Emergency — countdown active!');

  // Start countdown
  startCountdown(countdown);
}

/**
 * Cancel the active emergency.
 * Called by the "I'M OK" button.
 */
export function cancelEmergency() {
  if (!isActive) return;

  clearCountdown();
  isActive = false;
  hideOverlay();

  logger.emergency('✓ Emergency CANCELLED by user — no alert sent.');
  setStateDisplay('ok', 'Cancelled by user');

  if (onAlertCancelled) onAlertCancelled();

  // Reset state indicator after a delay
  setTimeout(() => setStateDisplay('ok', 'System Idle'), 4000);
}

/**
 * Called when countdown expires naturally.
 */
function onCountdownExpired() {
  isActive = false;
  hideOverlay();

  logger.emergency('⚡ Countdown EXPIRED — emergency alert would be sent!');
  logger.emergency('[SIM] In production: SMS dispatched via phone SIM + helmet SIM800L');
  logger.emergency('[SIM] Emergency contacts would be notified with GPS coordinates');

  setStateDisplay('sent', 'Alert SENT (simulated)');

  if (onAlertSent) onAlertSent();

  // Reset after 8 seconds
  setTimeout(() => setStateDisplay('ok', 'System Idle'), 8000);
}

// ═══════════════════════════════════════════════════════════════
// COUNTDOWN
// ═══════════════════════════════════════════════════════════════

function startCountdown(seconds) {
  countdownValue = seconds;
  updateCountdownDisplay(countdownValue);

  countdownTimer = setInterval(() => {
    countdownValue--;
    updateCountdownDisplay(countdownValue);

    if (countdownValue <= 0) {
      clearCountdown();
      onCountdownExpired();
    }
  }, 1000);
}

function clearCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

/**
 * Update the countdown number and the SVG ring progress.
 * The ring uses stroke-dashoffset to drain as time passes.
 */
function updateCountdownDisplay(remaining) {
  const numEl = document.getElementById('countdown-num');
  if (numEl) numEl.textContent = remaining;

  // SVG ring: full circle circumference for r=52 is 2π×52 ≈ 326.7px
  const circumference = 326.7;
  const circle = document.getElementById('countdown-circle');
  if (circle) {
    const fraction = remaining / DEFAULT_COUNTDOWN;
    const offset   = circumference * (1 - fraction);
    circle.style.strokeDashoffset = offset;

    // Color shifts red as time runs low
    if (remaining <= 3) {
      circle.style.stroke = '#FF1744';
    } else if (remaining <= 6) {
      circle.style.stroke = '#FF8800';
    } else {
      circle.style.stroke = '#FF1744';
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// OVERLAY
// ═══════════════════════════════════════════════════════════════

function showOverlay(source, gForce, lat, lon) {
  const overlay = document.getElementById('emergency-overlay');
  if (overlay) overlay.classList.remove('hidden');

  // Update source info
  const sourceEl = document.getElementById('emergency-source');
  if (sourceEl) {
    const sourceLabels = {
      SIMULATOR:        'Source: Manual Simulation',
      HELMET_BLE:       `Source: Helmet BLE | G-force: ${gForce.toFixed(2)}g`,
      PHONE_THRESHOLD:  `Source: G-force Threshold | ${gForce.toFixed(2)}g detected`,
      HIGH_G_INJECT:    `Source: High-G Injection | ${gForce.toFixed(2)}g`
    };
    sourceEl.textContent = sourceLabels[source] || `Source: ${source}`;
  }

  // Prevent background interaction
  document.body.style.overflow = 'hidden';
}

function hideOverlay() {
  const overlay = document.getElementById('emergency-overlay');
  if (overlay) overlay.classList.add('hidden');

  document.body.style.overflow = '';

  // Reset countdown display for next use
  updateCountdownDisplay(DEFAULT_COUNTDOWN);
}

// ═══════════════════════════════════════════════════════════════
// STATE DISPLAY
// ═══════════════════════════════════════════════════════════════

/**
 * Update the small state indicator card below the emergency buttons.
 * @param {'ok'|'pending'|'sent'} state
 * @param {string} text
 */
function setStateDisplay(state, text) {
  const dot  = document.querySelector('#emergency-state-display .state-dot');
  const span = document.getElementById('emergency-state-text');

  if (dot) {
    dot.className = `state-dot state-dot--${state}`;
  }
  if (span) span.textContent = text;
}

// ═══════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════

/**
 * Wire up emergency system DOM controls.
 * Call once from main.js.
 */
export function initEmergencyUI() {
  // Cancel button on overlay
  document.getElementById('btn-cancel-alert')
    ?.addEventListener('click', cancelEmergency);

  // Simulate fall button
  document.getElementById('btn-simulate-fall')
    ?.addEventListener('click', () => {
      triggerEmergency({ source: 'SIMULATOR', gForce: 0 });
    });

  // High-G pulse injection button
  document.getElementById('btn-inject-accel')
    ?.addEventListener('click', () => {
      logger.sys('[DBG] High-G pulse injection triggered by user');
      // This is handled by main.js to also update telemetry
      document.dispatchEvent(new CustomEvent('rideguard:inject-high-g'));
    });

  logger.sys('Emergency simulation system initialized.');
}

/**
 * Check if an emergency is currently active.
 */
export function isEmergencyActive() {
  return isActive;
}
