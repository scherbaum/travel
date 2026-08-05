import express from 'express';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
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

app.use(express.static(__dirname));

app.post('/api/plan-tour', async (req, res) => {
  const oauthToken = process.env.ANTHROPIC_OAUTH_TOKEN;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!oauthToken && !apiKey) return res.status(503).json({ error: 'No Claude credentials configured on server' });
  const authHeader = oauthToken ? `Bearer ${oauthToken}` : null;
  const apiKeyHeader = apiKey && !oauthToken ? apiKey : null;

  const { places } = req.body || {};
  if (!Array.isArray(places) || places.length < 2)
    return res.status(400).json({ error: 'Need at least 2 places' });

  const list = places.map((p, i) =>
    `${i + 1}. ${p.name} (${p.sub || ''}) — lat=${p.lat}, lng=${p.lng}, Besuch=${Math.round((p.visitMin || 60) / 60 * 10) / 10}h`
  ).join('\n');

  const prompt = `Du bist Sizilien-Reiseexpertin. Die Nutzerin hat ${places.length} Orte ausgewählt:\n\n${list}\n\nPlane die geografisch und zeitlich optimale Tagestour. Bedenke:\n- Minimiere Fahrtstrecken durch sinnvolle Reihenfolge\n- Sehenswürdigkeiten lieber morgens, Strände mittags/nachmittags\n- Realistische Reise-Einschätzung für Sizilien (kurvenreiche Straßen)\n\nAntworte NUR mit gültigem JSON, kein Text davor oder danach:\n{"order":[0,2,1,...],"reasoning":"Warum diese Reihenfolge (2-3 Sätze auf Deutsch)","tip":"Ein konkreter Insidertipp für diese Kombination"}`;

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
      const err = await r.text();
      return res.status(502).json({ error: `Claude API ${r.status}`, detail: err });
    }
    const data = await r.json();
    const text = data.content?.[0]?.text || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return res.status(502).json({ error: 'Kein JSON in Antwort', raw: text });
    res.json(JSON.parse(m[0]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(5000, () => console.log('travel.modulon.org :5000'));
