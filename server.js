/* ==================================================================
   VEGA SMART CITY — Node.js WebSocket relay server
   ==================================================================
   Replaces the ESP32's own AP + local web server with a server you
   host on Render.com. Two kinds of WebSocket clients connect to the
   SAME endpoint (/ws) and are told apart by a ?role= query param:

     - role=device     -> the ESP32 (joins your home/hotspot Wi-Fi,
                           talks to this server over the internet)
     - role=dashboard  -> any phone/laptop browser loading the page
                           this server serves at "/"

   Flow:
     Aries --(UART, "<SENSOR,TEMP:24.0,HUM:55,SOIL:42>")--> ESP32
     ESP32 --(WebSocket text: "SENSOR,TEMP:24.0,HUM:55,SOIL:42")--> here
     here --(broadcast JSON {type:"sensor",temp,hum,soil})--> dashboards

     dashboard --(WebSocket JSON {cmd:"..."})--> here
     here --(forward raw cmd string)--> ESP32
     ESP32 --(ariesLink.println(cmd))--> Aries   [unchanged from before]

   This keeps the exact same command vocabulary the Aries sketch
   already understands ('0'-'8', "SPEED:", "COLOR:", "FIGURE:",
   "FESTIVAL:", "TEXTSIZE:", free-text words) — only the transport
   between phone and ESP32 changed, from local HTTP to a hosted
   WebSocket.
   ================================================================== */

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const PORT = process.env.PORT || 3000;

// Optional shared-secret so randoms on the internet can't send
// commands to your ESP32 or spoof sensor data. Set this in Render's
// dashboard under Environment, then put the same value in the ESP32
// sketch and in the browser's URL (?token=...) or a login prompt.
const AUTH_TOKEN = process.env.AUTH_TOKEN || null;

app.use(express.static(path.join(__dirname, 'public')));

// Last known sensor reading, served immediately to any dashboard
// that connects before the next broadcast arrives.
let lastSensor = { temp: '--', hum: '--', soil: '--' };

const devices = new Set();
const dashboards = new Set();

function parseSensorFrame(frame) {
  // Expected: "SENSOR,TEMP:24.0,HUM:55,SOIL:42"
  if (!frame.startsWith('SENSOR')) return null;
  const t = frame.match(/TEMP:([^,]*)/);
  const h = frame.match(/HUM:([^,]*)/);
  const s = frame.match(/SOIL:(.*)/);
  if (!t || !h || !s) return null;
  return { temp: t[1].trim(), hum: h[1].trim(), soil: s[1].trim() };
}

function broadcast(set, data) {
  const msg = typeof data === 'string' ? data : JSON.stringify(data);
  for (const client of set) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const role = url.searchParams.get('role');   // 'device' | 'dashboard'
  const token = url.searchParams.get('token');

  if (AUTH_TOKEN && token !== AUTH_TOKEN) {
    ws.close(4001, 'unauthorized');
    return;
  }

  if (role === 'device') {
    devices.add(ws);
    ws.isAlive = true;
    console.log('[device] connected. total devices:', devices.size);

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      const text = raw.toString().trim();
      const parsed = parseSensorFrame(text);
      if (parsed) {
        lastSensor = parsed;
        broadcast(dashboards, { type: 'sensor', ...parsed });
      }
    });

    ws.on('close', () => {
      devices.delete(ws);
      console.log('[device] disconnected. total devices:', devices.size);
    });

    ws.on('error', (err) => console.error('[device] error:', err.message));
  } else if (role === 'dashboard') {
    dashboards.add(ws);
    ws.isAlive = true;
    ws.send(JSON.stringify({ type: 'sensor', ...lastSensor }));
    ws.send(JSON.stringify({ type: 'status', devices: devices.size }));

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let cmd;
      try {
        const msg = JSON.parse(raw.toString());
        cmd = msg.cmd;
      } catch {
        cmd = raw.toString();
      }
      if (!cmd || typeof cmd !== 'string' || cmd.length === 0 || cmd.length > 64) return;
      broadcast(devices, cmd); // forwarded verbatim, same as old POST /cmd
    });

    ws.on('close', () => dashboards.delete(ws));
    ws.on('error', (err) => console.error('[dashboard] error:', err.message));
  } else {
    ws.close(4000, 'role query param required: ?role=device or ?role=dashboard');
  }
});

// Simple health check Render (and you) can hit to confirm it's alive.
app.get('/healthz', (req, res) => res.send('ok'));

// Heartbeat: every 30s, ping every connected client. Any client that
// didn't respond to the PREVIOUS ping (isAlive still false) is dead —
// terminate it so a silently-dropped ESP32/browser doesn't linger in
// the devices/dashboards sets and swallow broadcasts into the void.
const HEARTBEAT_INTERVAL_MS = 30000;
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      const wasDevice = devices.has(ws);
      devices.delete(ws);
      dashboards.delete(ws);
      if (wasDevice) console.log('[device] heartbeat timeout, terminating stale connection. total devices:', devices.size);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`Smart City relay server listening on port ${PORT}`);
});
