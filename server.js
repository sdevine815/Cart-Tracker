// server.js
//
// Express service for Square clock-in tracking at ONE location.
//   GET  /api/square/current   -> who's clocked in now (name, email, since)
//   POST /api/square/webhook   -> ingests clock in/out webhooks
//   GET  /clocked-in           -> small test page
//   GET  /health               -> health check
//
// Requires Node 18+ (built-in fetch + crypto). One dependency: express.
//
// Setup:
//   export SQUARE_ACCESS_TOKEN="..."
//   export SQUARE_LOCATION_ID="..."
//   export SQUARE_ENV="production"            # or "sandbox"
//   export SQUARE_WEBHOOK_SIGNATURE_KEY="..."
//   export SQUARE_NOTIFICATION_URL="https://your-host/api/square/webhook"
//   export PORT=3000
//
// Run:  npm install && npm start

const express = require("express");
const crypto = require("crypto");
const fs = require("node:fs");
const { join } = require("node:path");
const { getCartLocations } = require("./life360");

const emailMap = (() => {
  try {
    const raw = JSON.parse(fs.readFileSync(join(__dirname, 'email-map.json'), 'utf8'));
    // Strip the comment key
    const { _comment: _, ...entries } = raw;
    return entries;
  } catch {
    return {};
  }
})();

const TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const SIGNATURE_KEY = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
const NOTIFICATION_URL = process.env.SQUARE_NOTIFICATION_URL;
const ENV = process.env.SQUARE_ENV || "sandbox";
const PORT = process.env.PORT || 3000;

const SQUARE_VERSION = "2025-05-21"; // min version for Timecard endpoints/events
const BASE_URL =
  ENV === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";

for (const [k, v] of Object.entries({
  SQUARE_ACCESS_TOKEN: TOKEN,
  SQUARE_LOCATION_ID: LOCATION_ID,
  SQUARE_WEBHOOK_SIGNATURE_KEY: SIGNATURE_KEY,
  SQUARE_NOTIFICATION_URL: NOTIFICATION_URL,
})) {
  if (!v) {
    console.error(`Missing required env var: ${k}`);
    process.exit(1);
  }
}

// --- Square helpers ---------------------------------------------------------

async function squareRequest(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Square-Version": SQUARE_VERSION,
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      `Square API error ${res.status} on ${path}: ` +
        JSON.stringify(data.errors || data)
    );
  }
  return data;
}

function shapeMember(m) {
  return {
    name: [m?.given_name, m?.family_name].filter(Boolean).join(" ") || "(no name)",
    email: m?.email_address || "(no email)",
  };
}

const memberCache = new Map();

async function resolveMember(id) {
  if (memberCache.has(id)) return memberCache.get(id);
  try {
    const data = await squareRequest("GET", `/v2/team-members/${id}`);
    const shaped = shapeMember(data.team_member);
    memberCache.set(id, shaped);
    return shaped;
  } catch {
    return { name: `(unknown: ${id})`, email: "(no email)" };
  }
}

async function getOpenTimecards() {
  const all = [];
  let cursor;
  do {
    const data = await squareRequest("POST", "/v2/labor/timecards/search", {
      query: {
        filter: { location_ids: [LOCATION_ID], status: "OPEN" },
        sort: { field: "START_AT", order: "DESC" },
      },
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    all.push(...(data.timecards || []));
    cursor = data.cursor;
  } while (cursor);
  return all;
}

function verifySignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  const expected = crypto
    .createHmac("sha256", SIGNATURE_KEY)
    .update(NOTIFICATION_URL + rawBody)
    .digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function processEvent(event) {
  const tc = event?.data?.object?.timecard;
  if (!tc || tc.location_id !== LOCATION_ID) return; // filter to our location

  const m = await resolveMember(tc.team_member_id);

  if (event.type === "labor.timecard.created") {
    console.log(`CLOCK IN  | ${m.name} <${m.email}> | ${tc.start_at}`);
  } else if (event.type === "labor.timecard.updated") {
    if (tc.end_at) {
      console.log(
        `CLOCK OUT | ${m.name} <${m.email}> | ${tc.start_at} -> ${tc.end_at}`
      );
    } else {
      const openBreak = (tc.breaks || []).some((b) => b.start_at && !b.end_at);
      console.log(`${openBreak ? "ON BREAK " : "UPDATED  "} | ${m.name} <${m.email}>`);
    }
  }
}

function toSquareEmail(life360Email) {
  return emailMap[life360Email] ?? life360Email;
}

// --- App --------------------------------------------------------------------

const app = express();

app.get("/health", (req, res) => res.json({ status: "ok" }));

// Live roster — queries open timecards on each request, so it's never stale.
/*
app.get("/api/square/current", async (req, res) => {
  try {
    const open = await getOpenTimecards();
    const clockedIn = [];
    for (const tc of open) {
      const m = await resolveMember(tc.team_member_id);
      clockedIn.push(m.email);
    }
    res.json({ count: clockedIn.length, clockedIn });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
*/

app.get("/api/cart-locations", async (req, res) => {
  try {
    const open = await getOpenTimecards();
    const clockedInEmails = new Set();
    for (const tc of open) {
      const m = await resolveMember(tc.team_member_id);
      clockedInEmails.add(m.email);
    }

    const allCarts = await getCartLocations()
    let carts = allCarts.filter((c) => c.email && clockedInEmails.has(toSquareEmail(c.email)));
    carts = carts.filter(cart => cart.coords.lat && cart.coords.long)
    res.json(carts)
    
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
})

// Webhook — express.raw keeps the exact bytes for signature verification.
// (Do NOT use express.json here; re-parsing changes the bytes and breaks it.)
app.post(
  "/api/square/webhook",
  express.raw({ type: "*/*" }),
  (req, res) => {
    const rawBody = req.body.toString("utf8");
    const signature = req.headers["x-square-hmacsha256-signature"];

    if (!verifySignature(rawBody, signature)) {
      return res.status(401).send("invalid signature");
    }

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return res.status(400).send("bad json");
    }

    // Long-lived process: acknowledge fast, then process.
    res.json({ received: true });
    processEvent(event).catch((err) =>
      console.error("Event processing error:", err.message)
    );
  }
);

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT} (env: ${ENV})`);
  console.log(`Location filter: ${LOCATION_ID}`);
  console.log(`Webhook URL must equal: ${NOTIFICATION_URL}`);
});