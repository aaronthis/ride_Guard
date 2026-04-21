# RideGuard Web Companion

A real-time development, monitoring, and simulation dashboard for the RideGuard smart motorcycle helmet system.

## What This Is

The Web Companion is a **development and simulation tool** — not the real safety system. It:

- Connects to the ESP32 helmet via Web Bluetooth
- Displays live telemetry (G-force, gyroscope, GPS)
- Simulates the full emergency alert workflow (no real SMS is sent)
- Logs ride sessions locally via IndexedDB
- Provides a serial monitor for raw packet inspection

## File Structure

```
rideguard-web/
├── index.html              ← Main app shell (single page)
├── styles.css              ← Complete dark-theme stylesheet
├── js/
│   ├── main.js             ← App entry point, orchestration
│   └── modules/
│       ├── ble.js          ← Web Bluetooth API layer
│       ├── telemetry.js    ← Data processing + UI updates
│       ├── emergency.js    ← Emergency simulation system
│       ├── map.js          ← Leaflet.js map integration
│       ├── storage.js      ← IndexedDB ride logging
│       ├── logger.js       ← Serial monitor + event logging
│       └── toast.js        ← Toast notification utility
└── README.md
```

## How to Run

### Option 1: Local HTTP Server (Recommended)

Web Bluetooth requires HTTPS or localhost. Use any of:

```bash
# Python 3
python3 -m http.server 8080

# Node.js (npx)
npx serve .

# Node.js (http-server)
npx http-server -p 8080

# PHP
php -S localhost:8080
```

Then open: `http://localhost:8080`

### Option 2: Live Server (VS Code)

Install the "Live Server" extension, right-click `index.html` → Open with Live Server.

### Option 3: Deploy to HTTPS

Upload to any static host (GitHub Pages, Netlify, Vercel). Web Bluetooth requires HTTPS on non-localhost.

## Browser Requirements

| Feature | Chrome | Firefox | Safari | Edge |
|---------|--------|---------|--------|------|
| Web Bluetooth | ✅ Full | ❌ No | ❌ No | ✅ Full |
| Geolocation | ✅ | ✅ | ✅ | ✅ |
| IndexedDB | ✅ | ✅ | ✅ | ✅ |
| ES Modules | ✅ | ✅ | ✅ | ✅ |

**Use Chrome for Web Bluetooth.** All other features work in any modern browser.

**Mobile:** Chrome on Android supports Web Bluetooth. iOS does not.

## Features

### Simulation Mode (No Hardware Needed)

The app automatically enters simulation mode when no BLE device is connected. It generates realistic telemetry data including:

- Sinusoidal ride vibration patterns
- GPS drift near Manila, Philippines
- NMEA string generation
- Battery drain simulation

Connect a real ESP32 helmet to switch to live data automatically.

### Connecting to the Helmet

1. Open in Chrome
2. Click **Connect Helmet** in the top bar
3. Chrome shows a device picker — select your **RideGuard-Helmet** ESP32
4. Telemetry streams immediately if firmware is running

**ESP32 must be advertising with name prefix `RideGuard` or `ESP32_Helmet`.**

### Emergency Simulation

- **Simulate Fall**: Triggers the full overlay countdown (10 seconds by default)
- **Inject High-G Pulse**: Injects a 4.5–6.5g telemetry packet to test threshold detection
- **Cancel Alert**: Click the big "I'M OK" button to cancel
- **Let it expire**: Watch the countdown reach zero → "alert sent" state

No real SMS is ever sent. All emergency events are logged to the serial monitor.

### Ride Logging

1. Click **Start Ride** in the top bar
2. Drive/simulate — all telemetry is logged
3. Click **End Ride** to save the session
4. View history in the bottom-right panel

Rides are saved to IndexedDB (falls back to localStorage if unavailable).

### Serial Monitor

The terminal panel shows:
- **BLE** (cyan): Raw BLE packets, connection events
- **GPS** (green): NMEA strings, position updates
- **MPU** (orange): Accelerometer/gyroscope data
- **System** (purple): App events, errors
- **Fall/Emergency** (red): High-priority alerts

Use the filter pills to isolate a category. Export logs to a text file with the **Export** button.

## BLE Protocol

The app expects an ESP32 GATT server with this profile:

```
Service: 12345678-1234-1234-1234-123456789ABC

Characteristics:
  Telemetry (Notify): 12345678-1234-1234-1234-123456789AB1
  Command (Write):    12345678-1234-1234-1234-123456789AB2
  Emergency (Notify): 12345678-1234-1234-1234-123456789AB3
```

Telemetry packets are UTF-8 JSON:

```json
{
  "ax": 0.012, "ay": -0.003, "az": 1.002,
  "at": 1.003,
  "gx": 1.2, "gy": -0.3, "gz": 0.5,
  "lat": 14.5995, "lon": 120.9842,
  "spd": 45.2, "alt": 25.0,
  "fix": 1, "sat": 8,
  "nmea": "$GPGGA,...",
  "bat": 82, "vlt": 3.85, "chg": false,
  "fall": false, "cal": false
}
```

See `rideguard_helmet_firmware.ino` in the Android project for the full ESP32 implementation.

## Known Limitations

1. **Web Bluetooth requires HTTPS or localhost** — won't work on plain HTTP
2. **iOS Safari has no Web Bluetooth** — simulation mode only on iPhone
3. **Map tiles require internet** — cached by browser, not pre-cached
4. **Single-tab app** — IndexedDB has no conflict resolution for multi-tab use
5. **Large route arrays**: Route history is capped at 5000 points to prevent memory issues

## Security Notes

- No credentials are stored
- No data leaves the browser (no backend)
- BLE connection requires explicit user gesture (browser security requirement)
- IndexedDB data is sandboxed to origin

## Development Tips

- Open DevTools → Application → IndexedDB → rideguard_db to inspect saved rides
- Open DevTools → Console for module-level debugging
- The Serial Monitor is the primary debugging tool — all events are logged there
- Use `btn-inject-accel` to test emergency threshold without triggering the full simulator
