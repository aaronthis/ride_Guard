/**
 * ble.js — Web Bluetooth API connection layer.
 *
 * Connects to an ESP32 advertising "RideGuard" name prefix.
 * Receives JSON telemetry via BLE Notify characteristic.
 * Sends commands via Write characteristic.
 *
 * GATT Profile (must match firmware):
 *   Service UUID:   12345678-1234-1234-1234-123456789ABC
 *   Telemetry UUID: 12345678-1234-1234-1234-123456789AB1 (Notify)
 *   Command UUID:   12345678-1234-1234-1234-123456789AB2 (Write)
 *   Emergency UUID: 12345678-1234-1234-1234-123456789AB3 (Notify)
 *
 * Events emitted (via callbacks):
 *   onTelemetry(data)      - parsed telemetry object
 *   onEmergencyAlert()     - fall detected from helmet
 *   onConnectionChange(s)  - 'connected' | 'disconnected' | 'reconnecting' | 'error'
 *   onRawPacket(str)       - raw JSON string for serial monitor
 */

import * as logger from './logger.js';

// BLE UUIDs — must match ESP32 firmware exactly
const SERVICE_UUID   = '12345678-1234-1234-1234-123456789abc';
const CHAR_TELEM_UUID = '12345678-1234-1234-1234-123456789ab1';
const CHAR_CMD_UUID   = '12345678-1234-1234-1234-123456789ab2';
const CHAR_EMERG_UUID = '12345678-1234-1234-1234-123456789ab3';

const RECONNECT_DELAY_MS  = 3000;
const MAX_RECONNECT_TRIES = 10;

let device         = null;   // BluetoothDevice
let server         = null;   // BluetoothRemoteGATTServer
let cmdCharacteristic = null; // For sending commands
let reconnectCount = 0;
let reconnectTimer = null;
let isConnecting   = false;

// Callbacks — set by modules that need BLE events
export let onTelemetry       = null;
export let onEmergencyAlert  = null;
export let onConnectionChange = null;
export let onRawPacket       = null;

/**
 * Check if Web Bluetooth is available in this browser.
 */
export function isSupported() {
  return 'bluetooth' in navigator;
}

/**
 * Open the browser's BLE device picker and connect.
 * The user must click a button to trigger this (browser security requirement).
 */
export async function connect() {
  if (!isSupported()) {
    logger.err('Web Bluetooth not supported. Use Chrome desktop or Android.');
    notifyConnectionChange('error');
    return;
  }

  if (isConnecting) return;
  isConnecting = true;

  try {
    logger.ble('Opening device picker — looking for RideGuard helmet…');

    device = await navigator.bluetooth.requestDevice({
      filters: [
        { namePrefix: 'RideGuard' },
        { namePrefix: 'rideguard' },
        { namePrefix: 'ESP32_Helmet' }
      ],
      optionalServices: [SERVICE_UUID]
    });

    logger.ble(`Device selected: ${device.name} (${device.id})`);

    // Listen for disconnections so we can auto-reconnect
    device.addEventListener('gattserverdisconnected', handleDisconnect);

    await connectToDevice();

  } catch (e) {
    // User cancelled the picker — not an error
    if (e.name === 'NotFoundError') {
      logger.ble('Device picker cancelled by user.');
    } else {
      logger.err(`BLE connect failed: ${e.message}`);
    }
    isConnecting = false;
    notifyConnectionChange('disconnected');
  }
}

/**
 * Internal: connect to the selected device and set up characteristics.
 */
async function connectToDevice() {
  try {
    logger.ble(`Connecting GATT to ${device.name}…`);
    notifyConnectionChange('reconnecting');

    server = await device.gatt.connect();
    logger.ble('GATT connected — discovering services…');

    const service = await server.getPrimaryService(SERVICE_UUID);
    logger.ble(`Service found: ${SERVICE_UUID}`);

    // Telemetry characteristic (ESP32 → Phone, Notify)
    const telemChar = await service.getCharacteristic(CHAR_TELEM_UUID);
    await telemChar.startNotifications();
    telemChar.addEventListener('characteristicvaluechanged', handleTelemetry);
    logger.ble('Telemetry notifications enabled.');

    // Emergency characteristic (ESP32 → Phone, Notify)
    try {
      const emergChar = await service.getCharacteristic(CHAR_EMERG_UUID);
      await emergChar.startNotifications();
      emergChar.addEventListener('characteristicvaluechanged', handleEmergencyChar);
      logger.ble('Emergency notifications enabled.');
    } catch {
      logger.ble('Emergency characteristic not found — fall detection via telemetry only.');
    }

    // Command characteristic (Phone → ESP32, Write)
    try {
      cmdCharacteristic = await service.getCharacteristic(CHAR_CMD_UUID);
      logger.ble('Command characteristic ready.');
    } catch {
      logger.ble('Command characteristic not found — commands disabled.');
    }

    reconnectCount = 0;
    isConnecting = false;
    notifyConnectionChange('connected');
    logger.ble(`Connected to ${device.name} — streaming telemetry.`);

  } catch (e) {
    isConnecting = false;
    logger.err(`GATT connection failed: ${e.message}`);
    notifyConnectionChange('disconnected');
    scheduleReconnect();
  }
}

/**
 * Handle incoming telemetry characteristic value change.
 * Parses JSON and calls onTelemetry callback.
 */
function handleTelemetry(event) {
  const value  = event.target.value;
  const decoder = new TextDecoder('utf-8');
  const raw = decoder.decode(value);

  // Log raw packet to serial monitor
  logger.mpu(`RAW BLE: ${raw}`);
  if (onRawPacket) onRawPacket(raw);

  try {
    const data = JSON.parse(raw);

    // Log parsed GPS NMEA separately if present
    if (data.nmea) {
      logger.gps(`NMEA: ${data.nmea}`);
    }

    // MPU summary
    logger.mpu(
      `Accel: ax=${(data.ax||0).toFixed(3)} ay=${(data.ay||0).toFixed(3)} az=${(data.az||0).toFixed(3)} | AT=${(data.at||0).toFixed(3)}g`
    );

    if (data.fall) {
      logger.fall('⚠ FALL FLAG detected in telemetry packet!');
    }

    if (onTelemetry) onTelemetry(data);

  } catch (e) {
    logger.err(`JSON parse failed: ${e.message} | raw: ${raw}`);
  }
}

/**
 * Handle emergency characteristic notification (separate from telemetry).
 */
function handleEmergencyChar(event) {
  const decoder = new TextDecoder('utf-8');
  const msg = decoder.decode(event.target.value);
  logger.fall(`⚠ EMERGENCY CHAR received: ${msg}`);
  if (onEmergencyAlert) onEmergencyAlert();
}

/**
 * Handle unexpected GATT disconnection.
 */
function handleDisconnect() {
  logger.ble(`Disconnected from ${device?.name || 'device'}.`);
  notifyConnectionChange('disconnected');
  cmdCharacteristic = null;
  scheduleReconnect();
}

/**
 * Schedule a reconnection attempt with delay and retry limit.
 */
function scheduleReconnect() {
  if (reconnectCount >= MAX_RECONNECT_TRIES) {
    logger.err(`Max reconnect attempts (${MAX_RECONNECT_TRIES}) reached. Giving up.`);
    notifyConnectionChange('error');
    return;
  }

  if (!device) return;

  reconnectCount++;
  const delay = RECONNECT_DELAY_MS * Math.min(reconnectCount, 3); // Progressive backoff
  logger.ble(`Reconnect attempt ${reconnectCount}/${MAX_RECONNECT_TRIES} in ${delay/1000}s…`);
  notifyConnectionChange('reconnecting');

  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(async () => {
    if (device && !device.gatt.connected) {
      isConnecting = true;
      await connectToDevice();
    }
  }, delay);
}

/**
 * Manually disconnect and stop reconnection attempts.
 */
export function disconnect() {
  clearTimeout(reconnectTimer);
  reconnectCount = MAX_RECONNECT_TRIES; // Prevent auto-reconnect
  cmdCharacteristic = null;

  if (device?.gatt.connected) {
    device.gatt.disconnect();
    logger.ble('Disconnected by user.');
  }

  device = null;
  server = null;
  notifyConnectionChange('disconnected');
}

/**
 * Send a command string to the ESP32.
 * @param {string} command - e.g. 'CAL', 'PING', 'REBOOT'
 * @returns {boolean} success
 */
export async function sendCommand(command) {
  if (!cmdCharacteristic) {
    logger.err(`Cannot send command "${command}" — not connected or no command characteristic.`);
    return false;
  }

  try {
    const encoder = new TextEncoder();
    await cmdCharacteristic.writeValue(encoder.encode(command));
    logger.ble(`Command sent: ${command}`);
    return true;
  } catch (e) {
    logger.err(`Command send failed: ${e.message}`);
    return false;
  }
}

/**
 * Check if currently connected to a BLE device.
 */
export function isConnected() {
  return device?.gatt?.connected === true;
}

/**
 * Get the connected device name (or null).
 */
export function getDeviceName() {
  return device?.name || null;
}

/**
 * Notify all listeners of a connection state change.
 * @param {'connected'|'disconnected'|'reconnecting'|'error'} state
 */
function notifyConnectionChange(state) {
  if (onConnectionChange) onConnectionChange(state);
}
