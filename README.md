# VEGA SACS OS

A multi-page "Smart City Governance" console. **Pole Management is the only
page currently wired to real hardware** — the other 8 are forward-looking
mockups (static UI, no live data) for features you'll build out later.

## Pages

| Page | File | Status |
|---|---|---|
| Fleet Overview | `fleet-overview.html` | Mockup |
| **Pole Management** | `pole-management.html` | **Live — controls your ESP32/Aries hardware** |
| Energy Analytics | `energy-analytics.html` | Mockup |
| Fault Reporting | `fault-reporting.html` | Mockup |
| Automation Rules | `automation-rules.html` | Mockup |
| User & Access Management | `user-access-management.html` | Mockup |
| Integrations | `integrations.html` | Mockup |
| System Logs | `system-logs.html` | Mockup |
| Billing/Reporting | `billing-reporting.html` | Mockup |

`index.html` redirects straight to `pole-management.html` (carrying your
`?token=...` along with it), since that's the page that actually does
something today. The top nav bar and sidebar on every page link to each
other correctly — the placeholder `href="#"` links from the original export
have been fixed.

## Why Pole Management already works

It was built against the exact same WebSocket protocol as your existing
Node relay server:

```
wss://your-app.onrender.com/ws?role=dashboard&token=YOUR_TOKEN
```

Same message shapes (`{"cmd": "..."}` out, `{"type":"sensor",...}` in), same
command vocabulary (`0`-`8`, `SPEED:`, `COLOR:`, `FIGURE:`, `FESTIVAL:`,
`TEXTSIZE:`, and the newer `FIGUREMODE:` from your `Aries_SmartCityDisplay_6`
firmware). **Your ESP32 firmware needs no changes** — it's protocol-agnostic
and just forwards whatever command string it receives.

## Deploy to Render (new project, separate from your old dashboard)

1. Push this folder to a **new** GitHub repo (don't mix it into your
   existing `websocket-remote-app` repo — you said you want this as its own
   project).
2. Render → **New → Web Service** → connect the new repo.
3. Settings:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. Environment variable (recommended, same idea as before):
   - `AUTH_TOKEN` = a secret string of your choice
5. Deploy. Once live, open:
   ```
   https://your-new-app.onrender.com/?token=YOUR_TOKEN
   ```
   It'll redirect straight into Pole Management.

## Your ESP32 sketch

Point `SERVER_HOST` in `ESP32_SmartCity_WSClient.ino` at this **new** app's
hostname (not your old one, since this is a separate Render service with
its own URL) — everything else in that sketch stays the same.

## Local testing

```bash
npm install
npm start
# visit http://localhost:3000
```

## As you add real functionality to other pages

Each mockup page currently has no `<script>` wiring to the server — they're
static HTML/Tailwind. When you're ready to bring one online (e.g. Fault
Reporting once you have real fault data), the pattern to copy is the
`<script>` block at the bottom of `pole-management.html`: open a WebSocket
to `/ws?role=dashboard`, listen for `message` events, and call `sendCmd()`
to push commands back through the same relay.
