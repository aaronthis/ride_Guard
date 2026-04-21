/**
 * toast.js — Non-blocking notification toasts.
 *
 * Lightweight utility for showing brief status messages.
 * Used throughout the app for connection events, save confirmations, etc.
 */

/**
 * Show a toast notification.
 * @param {string} message  - The message to display
 * @param {'info'|'success'|'warning'|'error'} type - Visual style
 * @param {number} duration - Milliseconds before auto-dismiss (0 = manual only)
 */
export function showToast(message, type = 'info', duration = 3000) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;

  container.appendChild(toast);

  if (duration > 0) {
    setTimeout(() => {
      toast.style.animation = 'none';
      toast.style.opacity   = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'opacity 0.3s, transform 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  return toast;
}

export const info    = (msg, dur) => showToast(msg, 'info', dur);
export const success = (msg, dur) => showToast(msg, 'success', dur);
export const warning = (msg, dur) => showToast(msg, 'warning', dur);
export const error   = (msg, dur) => showToast(msg, 'error', dur);
