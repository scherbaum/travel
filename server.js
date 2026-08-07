import express from 'express';
import compression from 'compression';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

// index.html ist ~123 KB unkomprimiert — ohne gzip geht das bei jedem Aufruf
// vollstaendig ueber die Leitung. (Die nginx.conf im Repo wird nicht benutzt,
// das Image startet direkt server.js.)
app.use(compression());
app.use(express.json({ limit: '1mb' }));

// Basic auth (activated when BASIC_AUTH_PASSWORD env var is set)
const AUTH_USER = process.env.BASIC_AUTH_USER || 'travel';
const AUTH_PASS = process.env.BASIC_AUTH_PASSWORD;
if (AUTH_PASS) {
  app.use((req, res, next) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Basic ')) {
      res.set('WWW-Authenticate', 'Basic realm="Travel Planner"');
      return res.status(401).send('Zugang gesperrt');
    }
    const [u, p] = Buffer.from(h.slice(6), 'base64').toString().split(':');
    if (u !== AUTH_USER || p !== AUTH_PASS) {
      res.set('WWW-Authenticate', 'Basic realm="Travel Planner"');
      return res.status(401).send('Falsches Passwort');
    }
    next();
  });
}

// index.html nie cachen (sonst sieht man nach einem Deploy die alte Version),
// Bilder dagegen lange.
app.use(express.static(__dirname, {
  setHeaders: (res, path) => {
    if (path.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
    else if (/\.(jpg|jpeg|png|webp|svg|ico)$/i.test(path)) res.setHeader('Cache-Control', 'public, max-age=604800');
  },
}));

// ── ROUTENOPTIMIERUNG ──
// Die Reihenfolge wird gerechnet, nicht vom Sprachmodell geraten. Ein LLM
// schaetzt Entfernungen nur grob und baut dadurch Umwege ein (im Test:
// 97,4 km statt 91,8 km, weil es von San Vito zurueck nach Zingaro und
// dann noch weiter suedlich nach Erice fuhr).

const R_EARTH = 6371;
function haversine(a, b) {
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(s));
}

// Sizilianische Strassen sind kurvig — Luftlinie unterschaetzt die Fahrstrecke.
const ROAD_FACTOR = 1.45;

function routeLength(order, D) {
  let sum = 0;
  for (let i = 0; i < order.length - 1; i++) sum += D[order[i]][order[i + 1]];
  return sum;
}

// 2-opt dreht Teilstuecke um, Or-opt verschiebt einzelne Orte (bzw. kurze
// Ketten) an eine bessere Stelle. Zusammen beseitigen sie die
// Vor-und-Zurueck-Schleifen zuverlaessiger als 2-opt allein.
function localSearch(order, D) {
  let best = order.slice(), improved = true, guard = 0;
  while (improved && guard++ < 300) {
    improved = false;
    let bestLen = routeLength(best, D);

    // 2-opt
    for (let i = 1; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const cand = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
        const len = routeLength(cand, D);
        if (len < bestLen - 1e-9) { best = cand; bestLen = len; improved = true; }
      }
    }

    // Or-opt: Ketten der Laenge 1..3 an anderer Stelle einfuegen
    for (let seg = 1; seg <= 3; seg++) {
      for (let i = 0; i + seg <= best.length; i++) {
        const chunk = best.slice(i, i + seg);
        const rest = best.slice(0, i).concat(best.slice(i + seg));
        for (let j = 0; j <= rest.length; j++) {
          if (j === i) continue;
          for (const piece of [chunk, chunk.slice().reverse()]) {
            const cand = rest.slice(0, j).concat(piece, rest.slice(j));
            const len = routeLength(cand, D);
            if (len < bestLen - 1e-9) { best = cand; bestLen = len; improved = true; }
          }
        }
      }
    }
  }
  return best;
}

function optimizeRoute(places, startIdx = null) {
  const n = places.length;
  const D = places.map(a => places.map(b => haversine(a, b)));

  // Bis 15 Orte: Held-Karp (dynamische Programmierung) → garantiert optimal.
  // Alle Reihenfolgen durchzuprobieren waere zu langsam: n! waechst brutal
  // (n=10 braucht so schon ~1,9 s und blockiert dabei den Event Loop).
  // Held-Karp kostet nur O(2^n · n^2), bei n=15 also Millisekunden statt Stunden.
  if (n <= 15) {
    const FULL = 1 << n;
    const INF = Infinity;
    // cost[mask][j] = kuerzester Weg, der genau die Orte in mask besucht und in j endet
    const cost = Array.from({ length: FULL }, () => new Float64Array(n).fill(INF));
    const prev = Array.from({ length: FULL }, () => new Int8Array(n).fill(-1));

    if (startIdx !== null) cost[1 << startIdx][startIdx] = 0;
    else for (let i = 0; i < n; i++) cost[1 << i][i] = 0;

    for (let mask = 1; mask < FULL; mask++) {
      for (let j = 0; j < n; j++) {
        const cur = cost[mask][j];
        if (cur === INF || !(mask & (1 << j))) continue;
        for (let k = 0; k < n; k++) {
          if (mask & (1 << k)) continue;
          const nm = mask | (1 << k);
          const nc = cur + D[j][k];
          if (nc < cost[nm][k]) { cost[nm][k] = nc; prev[nm][k] = j; }
        }
      }
    }

    let end = -1, bestLen = INF;
    for (let j = 0; j < n; j++) {
      if (cost[FULL - 1][j] < bestLen) { bestLen = cost[FULL - 1][j]; end = j; }
    }
    const order = [];
    let mask = FULL - 1, j = end;
    while (j !== -1) { order.push(j); const pj = prev[mask][j]; mask ^= (1 << j); j = pj; }
    order.reverse();
    return { order, km: bestLen };
  }

  // Ab 16 Orten: von jedem Start das naechstgelegene anhaengen, dann lokale Suche.
  let best = null, bestLen = Infinity;
  const starts = startIdx !== null ? [startIdx] : [...Array(n).keys()];
  for (const s of starts) {
    const unvisited = new Set([...Array(n).keys()]);
    unvisited.delete(s);
    const route = [s];
    while (unvisited.size) {
      let nearest = null, nd = Infinity;
      for (const c of unvisited) {
        if (D[route[route.length - 1]][c] < nd) { nd = D[route[route.length - 1]][c]; nearest = c; }
      }
      route.push(nearest); unvisited.delete(nearest);
    }
    const opt = localSearch(route, D);
    const len = routeLength(opt, D);
    if (len < bestLen) { bestLen = len; best = opt; }
  }
  return { order: best, km: bestLen };
}

app.post('/api/plan-tour', async (req, res) => {
  const oauthToken = process.env.ANTHROPIC_OAUTH_TOKEN;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const authHeader = oauthToken ? `Bearer ${oauthToken}` : null;
  const apiKeyHeader = apiKey && !oauthToken ? apiKey : null;

  const { places } = req.body || {};
  if (!Array.isArray(places) || places.length < 2)
    return res.status(400).json({ error: 'Need at least 2 places' });

  if (places.some(p => typeof p.lat !== 'number' || typeof p.lng !== 'number'))
    return res.status(400).json({ error: 'Alle Orte brauchen Koordinaten' });

  // 1) Kuerzeste Route rechnen (nicht vom Modell schaetzen lassen).
  const { order, km } = optimizeRoute(places);
  const ordered = order.map(i => places[i]);
  const driveKm = Math.round(km * ROAD_FACTOR);
  const driveMin = Math.round(km * ROAD_FACTOR / 65 * 60);
  const visitMin = places.reduce((a, p) => a + (p.visitMin || 90), 0);

  // Zum Vergleich: wie lang waere die Route in der Auswahlreihenfolge?
  const D = places.map(a => places.map(b => haversine(a, b)));
  const naiveKm = routeLength([...Array(places.length).keys()], D);
  const savedKm = Math.round((naiveKm - km) * ROAD_FACTOR);

  const legs = ordered.slice(0, -1).map((p, i) =>
    `   ${p.name} → ${ordered[i + 1].name}: ${Math.round(haversine(p, ordered[i + 1]) * ROAD_FACTOR)} km`
  ).join('\n');

  const list = ordered.map((p, i) =>
    `${i + 1}. ${p.name} (${p.sub || ''}) — Besuch ca. ${Math.round((p.visitMin || 90) / 60 * 10) / 10} h`
  ).join('\n');

  // 2) Das Modell kommentiert nur noch — die Reihenfolge steht bereits fest.
  const prompt = `Du bist Sizilien-Reiseexpertin. Diese Tagestour wurde bereits `
    + `geografisch auf die kürzeste Fahrstrecke optimiert (${driveKm} km, ca. `
    + `${Math.floor(driveMin / 60)}:${String(driveMin % 60).padStart(2, '0')} h Fahrt):\n\n${list}\n\n`
    + `Etappen:\n${legs}\n\n`
    + `Die Reihenfolge ist fest und darf NICHT geändert werden. Schreibe dazu:\n`
    + `- "reasoning": 2–3 Sätze auf Deutsch, warum diese Route zeitlich gut aufgeht `
    + `(Tageszeit: Sehenswürdigkeiten und Wanderungen früh wenn es kühl ist, Strände mittags, `
    + `Aussichtspunkte und Altstädte abends). Nenne konkrete Orte aus der Liste.\n`
    + `- "tip": ein konkreter Insidertipp für genau diese Kombination.\n\n`
    + `Antworte NUR mit gültigem JSON:\n{"reasoning":"...","tip":"..."}`;

  // Fallback, falls die Claude-API nicht erreichbar oder nicht konfiguriert ist:
  // Die Route steht trotzdem, nur der Kommentar fehlt.
  const routePayload = {
    order,
    km: driveKm,
    driveMin,
    visitMin,
    savedKm: savedKm > 0 ? savedKm : 0,
  };

  // Ohne Credentials trotzdem die optimierte Route zurueckgeben.
  if (!oauthToken && !apiKey) {
    return res.json({ ...routePayload, reasoning: '', tip: '', aiError: 'Keine Claude-Credentials auf dem Server' });
  }

  try {
    const headers = {
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    };
    if (authHeader) headers['Authorization'] = authHeader;
    if (apiKeyHeader) headers['x-api-key'] = apiKeyHeader;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!r.ok) {
      // Route trotzdem liefern — sie haengt nicht am Modell.
      return res.json({ ...routePayload, reasoning: '', tip: '', aiError: `Claude API ${r.status}` });
    }
    const data = await r.json();
    const text = data.content?.[0]?.text || '';
    const m = text.match(/\{[\s\S]*\}/);
    let extra = {};
    try { extra = m ? JSON.parse(m[0]) : {}; } catch {}
    res.json({
      ...routePayload,
      reasoning: extra.reasoning || '',
      tip: extra.tip || '',
    });
  } catch (e) {
    res.json({ ...routePayload, reasoning: '', tip: '', aiError: e.message });
  }
});

app.listen(5000, () => console.log('travel.modulon.org :5000'));
