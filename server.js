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
     Aries --(UART, "<SENSOR,TEMP:24.0,HUM:55,SOIL:42,LUX:120.5,
                      BRIGHT:50,AUTOBRIGHT:0,PUMP:0,PM25:-1,PM10:-1,
                      SOILM:41.2,SOILT:23.4,SOILPH:6.51,SOILEC:37,
                      SOILN:2,SOILP:3,SOILK:7>")--> ESP32
     ESP32 --(WebSocket text: same "SENSOR,..." string)--> here
     here --(broadcast JSON {type:"sensor",temp,hum,soil,lux,bright,
                              autobright,pump,pm25,pm10,soilm,soilt,
                              soilph,soilec,soiln,soilp,soilk})--> dashboards

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
let lastSensor = {
  temp: '--', hum: '--', soil: '--',
  lux: '--', bright: '--', autobright: '0',
  pump: '0', pm25: '--', pm10: '--',
  // RS485 JXBS-3001-TR soil probe (ESP32 UART2 -> Aries "SOILDATA:..." ->
  // Aries's SENSOR broadcast). '--' here just means "no field seen in
  // any SENSOR frame yet" — same as every other field's default below.
  // A present-but-failed reading arrives as the literal string "-1"
  // (the firmware's convention), same as temp/hum/soil already do;
  // the dashboard's fmtOrDash() is what turns that into "--" for display.
  soilm: '--', soilt: '--', soilph: '--', soilec: '--',
  soiln: '--', soilp: '--', soilk: '--',
};

const devices = new Set();
const dashboards = new Set();

function parseSensorFrame(frame) {
  // Expected: "SENSOR,TEMP:24.0,HUM:55,SOIL:42,LUX:120.5,BRIGHT:50,
  //            AUTOBRIGHT:0,PUMP:0,PM25:-1,PM10:-1,SOILM:41.2,
  //            SOILT:23.4,SOILPH:6.51,SOILEC:37,SOILN:2,SOILP:3,SOILK:7"
  if (!frame.startsWith('SENSOR')) return null;
  const t   = frame.match(/TEMP:([^,]*)/);
  const h   = frame.match(/HUM:([^,]*)/);
  const s   = frame.match(/SOIL:([^,]*)/);
  const lx  = frame.match(/LUX:([^,]*)/);
  const br  = frame.match(/BRIGHT:([^,]*)/);
  const ab  = frame.match(/AUTOBRIGHT:([^,]*)/);
  const pm  = frame.match(/PUMP:([^,]*)/);
  const p25 = frame.match(/PM25:([^,]*)/);
  const p10 = frame.match(/PM10:([^,]*)/);
  // RS485 JXBS-3001-TR soil probe fields. Note: SOILM/SOILT/SOILP must
  // be matched BEFORE the plain SOIL:/PM.. patterns above would ever
  // risk shadowing them — they don't here since the regexes require
  // the exact "SOIL:" / "PM25:" text, but keep that in mind if you
  // ever rename a field to a prefix of another one.
  const som = frame.match(/SOILM:([^,]*)/);
  const sot = frame.match(/SOILT:([^,]*)/);
  const soph = frame.match(/SOILPH:([^,]*)/);
  const soec = frame.match(/SOILEC:([^,]*)/);
  const son = frame.match(/SOILN:([^,]*)/);
  const sop = frame.match(/SOILP:([^,]*)/);
  const sok = frame.match(/SOILK:([^,]*)/);
  if (!t || !h || !s) return null;
  return {
    temp: t[1].trim(),
    hum: h[1].trim(),
    soil: s[1].trim(),
    lux: lx ? lx[1].trim() : '--',
    bright: br ? br[1].trim() : '--',
    autobright: ab ? ab[1].trim() : '0',
    pump: pm ? pm[1].trim() : '0',
    pm25: p25 ? p25[1].trim() : '--',
    pm10: p10 ? p10[1].trim() : '--',
    soilm: som ? som[1].trim() : '--',
    soilt: sot ? sot[1].trim() : '--',
    soilph: soph ? soph[1].trim() : '--',
    soilec: soec ? soec[1].trim() : '--',
    soiln: son ? son[1].trim() : '--',
    soilp: sop ? sop[1].trim() : '--',
    soilk: sok ? sok[1].trim() : '--',
  };
}

// Tell every dashboard how many ESP32 devices are online right now.
// Sent whenever a device connects/disconnects (not just once when the
// dashboard first opens) so the page can show "device offline".
function broadcastStatus() {
  broadcast(dashboards, { type: 'status', devices: devices.size });
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
    console.log('[device] connected. total devices:', devices.size);
    broadcastStatus();

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
      broadcastStatus();
    });

    ws.on('error', (err) => console.error('[device] error:', err.message));
  } else if (role === 'dashboard') {
    dashboards.add(ws);
    ws.send(JSON.stringify({ type: 'sensor', ...lastSensor }));
    ws.send(JSON.stringify({ type: 'status', devices: devices.size }));

    ws.on('message', (raw) => {
      let cmd;
      try {
        const msg = JSON.parse(raw.toString());
        cmd = msg.cmd;
      } catch {
        cmd = raw.toString();
      }
      if (!cmd || typeof cmd !== 'string' || cmd.length === 0 || cmd.length > 64) return;
      if (devices.size === 0) {
        console.log('[dashboard] command dropped, no device online:', cmd);
        ws.send(JSON.stringify({ type: 'error', msg: 'ESP32 device is offline - command not delivered', cmd }));
        return;
      }
      console.log('[dashboard] -> device:', cmd);
      broadcast(devices, cmd); // forwarded verbatim, same as old POST /cmd
    });

    ws.on('close', () => dashboards.delete(ws));
    ws.on('error', (err) => console.error('[dashboard] error:', err.message));
  } else {
    ws.close(4000, 'role query param required: ?role=device or ?role=dashboard');
  }
});

// Keepalive: ping every client every 25s and drop any that miss two
// pongs in a row. Proxies (Render's included) silently kill idle or
// half-dead WebSockets, and without this the server keeps "sending" to
// a dead ESP32 socket while the dashboard looks fine.
wss.on('connection', (ws) => {
  ws.missedPongs = 0;
  ws.on('pong', () => { ws.missedPongs = 0; });
});
setInterval(() => {
  for (const client of wss.clients) {
    if (client.missedPongs >= 2) { client.terminate(); continue; }
    client.missedPongs++;
    try { client.ping(); } catch (e) { /* closed */ }
  }
}, 25000);

// Simple health check Render (and you) can hit to confirm it's alive.
app.get('/healthz', (req, res) => res.send('ok'));

server.listen(PORT, () => {
  console.log(`Smart City relay server listening on port ${PORT}`);
});
