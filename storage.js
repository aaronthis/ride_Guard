/**
 * storage.js — Persistent ride session logging via IndexedDB.
 *
 * Stores:
 *  - Ride sessions (start/end time, distance, max G-force, route, incidents)
 *
 * Falls back to localStorage if IndexedDB unavailable.
 *
 * Schema:
 *   DB: rideguard_db
 *   Store: ride_sessions
 *     id:          auto-increment
 *     startTime:   timestamp ms
 *     endTime:     timestamp ms
 *     distanceKm:  float
 *     maxGForce:   float
 *     route:       [{lat, lng}]
 *     incident:    boolean (true if emergency was triggered)
 *     avgSpeedKmh: float
 */

import * as logger from './logger.js';

const DB_NAME    = 'rideguard_db';
const DB_VERSION = 1;
const STORE_NAME = 'ride_sessions';

let db = null;

/**
 * Open (or create) the IndexedDB database.
 * Must be called before any other storage operations.
 */
export async function initStorage() {
  if (!window.indexedDB) {
    logger.sys('IndexedDB not available — ride history disabled.');
    return false;
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      logger.err(`IndexedDB open failed: ${request.error?.message}`);
      reject(request.error);
    };

    request.onsuccess = () => {
      db = request.result;
      logger.sys('IndexedDB opened — ride history ready.');
      resolve(true);
    };

    // Create object store on first run (or version upgrade)
    request.onupgradeneeded = (event) => {
      const upgradeDb = event.target.result;

      if (!upgradeDb.objectStoreNames.contains(STORE_NAME)) {
        const store = upgradeDb.createObjectStore(STORE_NAME, {
          keyPath: 'id',
          autoIncrement: true
        });
        store.createIndex('startTime', 'startTime', { unique: false });
        logger.sys('IndexedDB schema created.');
      }
    };
  });
}

/**
 * Save a completed ride session to the database.
 *
 * @param {Object} session
 * @param {number}   session.startTime   - Unix ms
 * @param {number}   session.endTime     - Unix ms
 * @param {number}   session.distanceKm  - Calculated from route
 * @param {number}   session.maxGForce   - Peak G-force during ride
 * @param {Array}    session.route       - [{lat, lng}] coordinate array
 * @param {boolean}  session.incident    - Was emergency triggered?
 * @param {number}   session.avgSpeedKmh - Average speed
 * @returns {number} The new session ID
 */
export async function saveRide(session) {
  if (!db) {
    // Fallback to localStorage
    return saveRideLocalStorage(session);
  }

  return new Promise((resolve, reject) => {
    const tx    = db.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req   = store.add(session);

    req.onsuccess = () => {
      logger.sys(`Ride saved to IndexedDB (id=${req.result}) — ${session.distanceKm.toFixed(2)}km, maxG=${session.maxGForce.toFixed(2)}g`);
      resolve(req.result);
    };

    req.onerror = () => {
      logger.err(`Failed to save ride: ${req.error?.message}`);
      reject(req.error);
    };
  });
}

/**
 * Load all ride sessions from the database (newest first).
 * @returns {Array} Array of session objects
 */
export async function loadAllRides() {
  if (!db) {
    return loadRidesLocalStorage();
  }

  return new Promise((resolve, reject) => {
    const tx      = db.transaction([STORE_NAME], 'readonly');
    const store   = tx.objectStore(STORE_NAME);
    const req     = store.getAll();

    req.onsuccess = () => {
      const rides = req.result.reverse(); // Newest first
      resolve(rides);
    };

    req.onerror = () => {
      logger.err(`Failed to load rides: ${req.error?.message}`);
      reject(req.error);
    };
  });
}

/**
 * Delete all ride sessions.
 */
export async function clearAllRides() {
  if (!db) {
    localStorage.removeItem('rideguard_rides');
    return;
  }

  return new Promise((resolve, reject) => {
    const tx    = db.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req   = store.clear();

    req.onsuccess = () => {
      logger.sys('All ride history cleared.');
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Calculate distance in km from an array of [lat, lng] pairs.
 * Uses the Haversine formula.
 * @param {Array} coords - [{lat, lng}] or [[lat, lng]]
 * @returns {number} distance in km
 */
export function calculateDistance(coords) {
  if (!coords || coords.length < 2) return 0;

  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const lat1 = (a[0] ?? a.lat) * Math.PI / 180;
    const lat2 = (b[0] ?? b.lat) * Math.PI / 180;
    const dLat = lat2 - lat1;
    const dLon = ((b[1] ?? b.lng) - (a[1] ?? a.lng)) * Math.PI / 180;

    const h = Math.sin(dLat/2)**2 +
              Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon/2)**2;

    total += 6371 * 2 * Math.asin(Math.sqrt(h)); // Earth radius = 6371 km
  }

  return total;
}

// ═══════════════════════════════════════════════════════════════
// RIDE HISTORY UI
// ═══════════════════════════════════════════════════════════════

/**
 * Render the ride history list and aggregate stats in the DOM.
 * Call after saving a ride or on app load.
 */
export async function renderRideHistory() {
  const rides = await loadAllRides().catch(() => []);
  const list  = document.getElementById('history-list');
  if (!list) return;

  // Aggregate stats
  const totalDist  = rides.reduce((s, r) => s + (r.distanceKm || 0), 0);
  const incidents  = rides.filter(r => r.incident).length;

  document.getElementById('stat-total-rides').textContent = rides.length;
  document.getElementById('stat-total-dist').textContent  = `${totalDist.toFixed(1)} km`;
  document.getElementById('stat-incidents').textContent   = incidents;

  if (rides.length === 0) {
    list.innerHTML = '<p class="empty-state">No rides recorded yet. Start a ride to begin logging.</p>';
    return;
  }

  list.innerHTML = '';

  rides.forEach(ride => {
    const start    = new Date(ride.startTime);
    const dur      = ride.endTime ? Math.round((ride.endTime - ride.startTime) / 60000) : 0;
    const dateStr  = start.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

    const item = document.createElement('div');
    item.className = 'history-item';
    item.innerHTML = `
      <div class="history-item__header">
        <span class="history-item__date">${dateStr}</span>
        ${ride.incident ? '<span class="history-item__incident">⚠ Incident</span>' : ''}
      </div>
      <div class="history-item__stats">
        <span>📍 ${(ride.distanceKm || 0).toFixed(2)} km</span>
        <span>⚡ Max ${(ride.maxGForce || 0).toFixed(2)}g</span>
        <span>⏱ ${dur} min</span>
      </div>
    `;
    list.appendChild(item);
  });
}

// ═══════════════════════════════════════════════════════════════
// LOCALSTORAGE FALLBACK
// ═══════════════════════════════════════════════════════════════

function saveRideLocalStorage(session) {
  try {
    const rides = loadRidesLocalStorage();
    session.id  = Date.now();
    rides.unshift(session);
    // Keep only last 50 rides in localStorage (size limit)
    const trimmed = rides.slice(0, 50);
    localStorage.setItem('rideguard_rides', JSON.stringify(trimmed));
    logger.sys('Ride saved to localStorage (IndexedDB fallback).');
    return session.id;
  } catch (e) {
    logger.err(`localStorage save failed: ${e.message}`);
    return null;
  }
}

function loadRidesLocalStorage() {
  try {
    return JSON.parse(localStorage.getItem('rideguard_rides') || '[]');
  } catch {
    return [];
  }
}
