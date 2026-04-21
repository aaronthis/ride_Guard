/**
 * logger.js — Centralized logging for the Serial Monitor panel.
 *
 * All modules call logger.log() with a category tag.
 * The logger writes to the DOM terminal and emits events for
 * other modules to listen to (e.g., storage.js saves to IndexedDB).
 *
 * Categories: 'ble' | 'gps' | 'mpu' | 'sys' | 'err' | 'fall' | 'emergency'
 */

const MAX_LOG_LINES = 500;       // Cap in-DOM lines to avoid memory growth
const MAX_EXPORT_LINES = 2000;   // In-memory export buffer

const logBuffer = [];            // [{timestamp, category, text}] for export
let activeFilter = 'all';        // Current filter pill selection
let autoScroll = true;           // Auto-scroll toggle state

/**
 * Format a timestamp as HH:MM:SS.mmm
 */
function formatTimestamp(date = new Date()) {
  const h  = String(date.getHours()).padStart(2, '0');
  const m  = String(date.getMinutes()).padStart(2, '0');
  const s  = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

/**
 * Write a log line to the Serial Monitor DOM.
 * @param {string} category - 'ble' | 'gps' | 'mpu' | 'sys' | 'err' | 'fall' | 'emergency'
 * @param {string} text     - Log message body
 */
export function log(category, text) {
  const ts    = formatTimestamp();
  const line  = `[${ts}] [${category.toUpperCase()}] ${text}`;
  const entry = { timestamp: Date.now(), category, text: line };

  // Store in memory buffer for export
  logBuffer.push(entry);
  if (logBuffer.length > MAX_EXPORT_LINES) logBuffer.shift();

  // Write to DOM
  const output = document.getElementById('serial-output');
  if (!output) return;

  const div = document.createElement('div');
  div.className = `serial-line ${category}`;
  div.textContent = line;

  // Apply current filter
  if (activeFilter !== 'all' && category !== activeFilter) {
    div.classList.add('hidden-by-filter');
  }

  output.appendChild(div);

  // Prune DOM to keep it fast
  const lines = output.querySelectorAll('.serial-line');
  if (lines.length > MAX_LOG_LINES) {
    lines[0].remove();
  }

  // Auto-scroll to bottom
  if (autoScroll) {
    output.scrollTop = output.scrollHeight;
  }
}

/**
 * Convenience wrappers
 */
export const ble       = (text) => log('ble',       text);
export const gps       = (text) => log('gps',       text);
export const mpu       = (text) => log('mpu',       text);
export const sys       = (text) => log('sys',       text);
export const err       = (text) => log('err',       text);
export const fall      = (text) => log('fall',      text);
export const emergency = (text) => log('emergency', text);

/**
 * Clear the serial monitor and in-memory buffer.
 */
export function clearLogs() {
  const output = document.getElementById('serial-output');
  if (output) output.innerHTML = '';
  logBuffer.length = 0;
  sys('Log cleared by user.');
}

/**
 * Export all logs as a plain text file download.
 */
export function exportLogs() {
  const content = logBuffer.map(e => e.text).join('\n');
  const blob = new Blob([content], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `rideguard-log-${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  sys('Log exported to file.');
}

/**
 * Apply a category filter to displayed log lines.
 * @param {string} filter - 'all' | 'ble' | 'gps' | 'mpu' | 'sys'
 */
export function setFilter(filter) {
  activeFilter = filter;
  const output = document.getElementById('serial-output');
  if (!output) return;

  output.querySelectorAll('.serial-line').forEach(div => {
    const cat = Array.from(div.classList).find(c => c !== 'serial-line' && c !== 'hidden-by-filter');
    if (filter === 'all' || cat === filter) {
      div.classList.remove('hidden-by-filter');
    } else {
      div.classList.add('hidden-by-filter');
    }
  });
}

/**
 * Set auto-scroll state.
 * @param {boolean} enabled
 */
export function setAutoScroll(enabled) {
  autoScroll = enabled;
}

/**
 * Wire up the Serial Monitor controls in the DOM.
 * Call once from main.js after DOM is ready.
 */
export function initSerialMonitorUI() {
  // Clear button
  document.getElementById('btn-clear-log')
    ?.addEventListener('click', clearLogs);

  // Export button
  document.getElementById('btn-export-log')
    ?.addEventListener('click', exportLogs);

  // Auto-scroll checkbox
  const chk = document.getElementById('chk-autoscroll');
  chk?.addEventListener('change', () => setAutoScroll(chk.checked));

  // Filter pills
  document.querySelectorAll('.filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      setFilter(pill.dataset.filter);
    });
  });
}
