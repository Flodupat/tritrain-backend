import { GarminConnect } from 'garmin-connect';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const path = req.url.split('?')[0];

  async function login(email, password) {
    const client = new GarminConnect({ username: email, password });
    await client.login();
    return client;
  }

  // ── POST /api/auth ────────────────────────────────────────
  if (req.method === 'POST') {
    const { email, password } = req.body || {};
    if (!email || !password)
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    try {
      const client = await login(email, password);
      const profile = await client.getUserProfile();
      const name = profile.displayName || profile.userName || email;
      return res.status(200).json({ success: true, name });
    } catch (e) {
      return res.status(401).json({ error: `Connexion échouée : ${e.message}` });
    }
  }

  // ── GET routes ────────────────────────────────────────────
  if (req.method === 'GET') {
    const { email, password, days = '14' } = req.query;
    if (!email || !password)
      return res.status(400).json({ error: 'email et password requis' });

    // Health check
    if (path === '/api/index' || path === '/') {
      return res.status(200).json({ status: 'ok', message: 'TriTrain Garmin API' });
    }

    let client;
    try {
      client = await login(email, password);
    } catch (e) {
      return res.status(401).json({ error: `Connexion échouée : ${e.message}` });
    }

    // GET /api/garmin/activities
    if (path.includes('/activities')) {
      try {
        const activities = await client.getActivities(0, parseInt(days) * 2);
        const result = activities.map(a => {
          const sport = mapSport(a.activityType?.typeKey || '');
          const dur_s = a.duration || 0;
          const dist  = a.distance || 0;
          const swimPace = (sport === 'S' && dist && dur_s)
            ? fmtTime((dur_s / dist) * 100) : null;
          return {
            id:        a.activityId,
            date:      (a.startTimeLocal || '').slice(0, 10),
            name:      a.activityName || '',
            sport,
            duration:  Math.round(dur_s / 60 * 10) / 10,
            distance:  Math.round(dist / 1000 * 100) / 100,
            avgHR:     a.averageHR || null,
            maxHR:     a.maxHR || null,
            avgPower:  a.avgPower || null,
            normPower: a.normPower || null,
            avgPace:   sport === 'R' && a.averageSpeed
              ? fmtTime(1000 / a.averageSpeed) : null,
            swimPace,
            calories:  a.calories || null,
          };
        });
        return res.status(200).json({ activities: result, count: result.length });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    // GET /api/garmin/stats
    if (path.includes('/stats')) {
      try {
        const activities = await client.getActivities(0, 60);
        const today     = new Date();
        const monOffset = (today.getDay() + 6) % 7;
        const weekStart = new Date(today);
        weekStart.setDate(today.getDate() - monOffset);
        const weekStr = weekStart.toISOString().slice(0, 10);

        const weekly = { swim: 0, zwift: 0, run: 0, total: 0 };
        const powers = [], paces = [], swims = [];

        for (const a of activities) {
          const sport = mapSport(a.activityType?.typeKey || '');
          const dur   = (a.duration || 0) / 60;
          const date  = (a.startTimeLocal || '').slice(0, 10);

          if (date >= weekStr) {
            if (sport === 'S')      weekly.swim  += dur;
            else if (sport === 'Z') weekly.zwift += dur;
            else if (sport === 'R') weekly.run   += dur;
            weekly.total += dur;
          }
          if (sport === 'Z' && a.avgPower && powers.length < 5)
            powers.push(a.normPower || a.avgPower);
          if (sport === 'R' && a.averageSpeed && paces.length < 5)
            paces.push(1000 / a.averageSpeed);
          if (sport === 'S' && a.distance && a.duration && swims.length < 5)
            swims.push((a.duration / a.distance) * 100);
        }

        return res.status(200).json({
          weekly: {
            swim:  Math.round(weekly.swim),
            zwift: Math.round(weekly.zwift),
            run:   Math.round(weekly.run),
            total: Math.round(weekly.total),
          },
          avgPower:   powers.length ? Math.round(powers.reduce((a,b)=>a+b)/powers.length) : null,
          avgPaceFmt: paces.length  ? fmtTime(paces.reduce((a,b)=>a+b)/paces.length)      : null,
          avgSwimFmt: swims.length  ? fmtTime(swims.reduce((a,b)=>a+b)/swims.length)       : null,
        });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    return res.status(200).json({ status: 'ok', message: 'TriTrain Garmin API' });
  }

  res.status(404).json({ error: 'Route inconnue' });
}

function mapSport(tk) {
  tk = tk.toLowerCase();
  if (tk.includes('swim'))                                              return 'S';
  if (['cycling','indoor','virtual','zwift'].some(x => tk.includes(x))) return 'Z';
  if (['running','trail'].some(x => tk.includes(x)))                    return 'R';
  return 'OTHER';
}

function fmtTime(sec) {
  if (!sec) return null;
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}
