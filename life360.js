import https from 'node:https';

const TOKEN  = process.env.LIFE360_TOKEN;
const CIRCLE = process.env.LIFE360_CIRCLE ?? 'Mission Test';

if (!TOKEN) throw new Error('LIFE360_TOKEN env var is required');

const URLS = {
  circles: 'https://api-cloudfront.life360.com/v4/circles',
  members: (id) => `https://api-cloudfront.life360.com/v3/circles/${id}/members`,
};

const USER_AGENT = 'com.life360.android.safetymapd/KOKO/23.50.0 android/13';

// Android 13 (Conscrypt) cipher ordering — bypasses Life360's JA3 fingerprint check on Cloudflare
const tlsAgent = new https.Agent({
  keepAlive: false,
  minVersion: 'TLSv1.2',
  ciphers: [
    'TLS_AES_128_GCM_SHA256',
    'TLS_AES_256_GCM_SHA384',
    'TLS_CHACHA20_POLY1305_SHA256',
    'ECDHE-ECDSA-AES128-GCM-SHA256',
    'ECDHE-ECDSA-AES256-GCM-SHA384',
    'ECDHE-ECDSA-CHACHA20-POLY1305',
    'ECDHE-RSA-AES128-GCM-SHA256',
    'ECDHE-RSA-AES256-GCM-SHA384',
    'ECDHE-RSA-CHACHA20-POLY1305',
  ].join(':'),
});

function request(url, retries = 2) {
  const parsed = new URL(url);
  const attempt = () =>
    new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
          method: 'GET',
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            'User-Agent': USER_AGENT,
            Accept: 'application/json',
            'Cache-Control': 'no-cache',
          },
          agent: tlsAgent,
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => (raw += chunk));
          res.on('end', () => {
            if (res.statusCode === 401) return reject(new Error('Token expired or invalid.'));
            if (res.statusCode === 403) return reject(new Error('Forbidden — token may be stale.'));
            if (res.statusCode === 429) return reject(new Error('Rate limited.'));
            if (res.statusCode < 200 || res.statusCode >= 300)
              return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
            try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
          });
        },
      );
      req.on('error', reject);
      req.end();
    });

  const run = (n) => attempt().catch((err) => (n > 0 ? run(n - 1) : Promise.reject(err)));
  return run(retries);
}

async function getCircles() {
  const data = await request(URLS.circles);
  return data.circles;
}

async function getCircleMembers(circleId) {
  const data = await request(URLS.members(circleId));
  return data.members;
}

function parseLocations(members) {
  return members.map((m) => ({
    name: `${m.firstName} ${m.lastName}`,
    email: m.loginEmail ?? null,
    phone: m.loginPhone ?? null,
    lat: m.location?.latitude ?? null,
    lng: m.location?.longitude ?? null,
    address: m.location?.name ?? null,
    speed: m.location?.speed ?? null,
    battery: m.location?.battery ?? null,
    accuracy: m.location?.accuracy ?? null,
    isDriving: m.location?.isDriving === '1',
    timestamp: m.location?.timestamp
      ? new Date(Number(m.location.timestamp) * 1000).toISOString()
      : null,
  }));
}

export async function getCartLocations() {
  const circles = await getCircles();
  const target  = circles.find((c) => c.name === CIRCLE);
  if (!target) throw new Error(`Circle "${CIRCLE}" not found.`);
  const members   = await getCircleMembers(target.id);
  const locations = parseLocations(members);

  return locations.map((loc) => ({
    name:    loc.name,
    email:   loc.email,
    phone:   loc.phone,
    coords:  { lat: loc.lat, long: loc.lng },
    address: loc.address,
    battery: loc.battery,
    updated: loc.timestamp,
  }));
}