export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const path = req.url.split('?')[0].replace('/api/index', '');

  // ── Auth helper ──────────────────────────────────────────
  async function garminLogin(email, password) {
    const BASE = 'https://connect.garmin.com';
    const SSO  = 'https://sso.garmin.com/sso';

    // 1. Get CSRF token
    const loginPage = await fetch(`${SSO}/signin?service=${encodeURIComponent(BASE + '/modern')}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const html = await loginPage.text();
    const csrf = html.match(/name="_csrf"\s+value="([^"]+)"/)?.[1] || '';
    const cookies = loginPage.headers.get('set-cookie') || '';

    // 2. POST credentials
    const params = new URLSearchParams({
      username: email,
      password,
      _csrf: csrf,
      embed: 'false',
      lt: '',
      execution: 'e1s1',
      _eventId: 'submit',
      displayNameRequired: 'false',
    });

    const loginResp = await fetch(`${SSO}/signin?service=${encodeURIComponent(BASE + '/modern')}`, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookies,
        'Origin': SSO,
        'Referer': `${SSO}/signin`,
      },
      body: params.toString(),
      redirect: 'manual',
    });

    const allCookies = [cookies, loginResp.headers.get('set-cookie') || ''].join('; ');
    const ticket = loginResp.headers.get('location') || '';

    // 3. Exchange ticket
    if (ticket) {
      const ticketResp = await fetch(ticket, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': allCookies },
        redirect: 'manual',
      });
      const finalCookies = [allCookies, ticketResp.headers.get('set-cookie') || ''].join('; ');
      return finalCookies;
    }
    throw new Error('Login failed — mauvais identifiants ?');
  }

  async function garminGet(url, cookies) {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Cookie': cookies,
        'NK': 'NT',
        'X-app-ver': '4.70.1.0',
        'Accept': 'application/json',
      }
    });
    if (!r.ok) throw new Error(`Garmin API error ${r.status} on ${url}`);
    return r.json();
  }

  // ── POST /api/garmin/auth ─────────────────────────────────
  if (req.method === 'POST') {
    const { email, password } = req.body || {};
    if (!email || !password)
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    try {
      const cookies = await garminLogin(email, password);
      const profile = await garminGet(
        'https://connect.garmin.com/modern/proxy/userprofile-service/socialProfile',
        cookies
      );
      const name = profile.displayName || profile.userName || email;
      return res.status(200).json({ success: true, name });
    } catch (e) {
      return res.status(401).json({ error: e.message });
    }
  }

  // ── GET routes ────────────────────────────────────────────
  if (req.method === 'GET') {
    const { email, password, days = '14' } = req.query;
    if (!email || !password)
      return res.status(400).json({ error: 'email et password requis' });

    let cookies;
    try {
      cookies = await garminLogin(email, password);
    } catch (e) {
      return res.status(401).json({ error: e.message });
    }

    // GET /api/garmin/activities
    if (path === '/garmin/activities' || path === '/api/garmin/activities') {
      try {
        const limit = parseInt(days) * 2;
        const data  = await garminGet(
          `https://connect.garmin.com/modern/proxy/activitylist-service/activities/search/activities?limit=${limit}&start=0`,
          cookies
        );
        const activities = (data || []).map(a => {
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
            avgPace:   sport === 'R' && a.averageSpeed ? fmtTime(1000 / a.averageSpeed) : null,
            swimPace,
            calories:  a.calories || null,
          };
        });
        return res.status(200).json({ activities, count: activities.length });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    // GET /api/garmin/stats
    if (path === '/garmin/stats' || path === '/api/garmin/stats') {
      try {
        const data = await garminGet(
          `https://connect.garmin.com/modern/proxy/activitylist-service/activities/search/activities?limit=60&start=0`,
          cookies
        );
        const today     = new Date();
        const monOffset = (today.getDay() + 6) % 7;
        const weekStart = new Date(today);
        weekStart.setDate(today.getDate() - monOffset);
        const weekStr = weekStart.toISOString().slice(0, 10);

        const weekly = { swim: 0, zwift: 0, run: 0, total: 0 };
        const powers = [], paces = [], swims = [];

        for (const a of (data || [])) {
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
          weekly:     { swim: Math.round(weekly.swim), zwift: Math.round(weekly.zwift), run: Math.round(weekly.run), total: Math.round(weekly.total) },
          avgPower:   powers.length ? Math.round(powers.reduce((a,b)=>a+b)/powers.length) : null,
          avgPaceFmt: paces.length  ? fmtTime(paces.reduce((a,b)=>a+b)/paces.length)     : null,
          avgSwimFmt: swims.length  ? fmtTime(swims.reduce((a,b)=>a+b)/swims.length)      : null,
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
  if (tk.includes('swim'))                                          return 'S';
  if (['cycling','indoor','virtual','zwift'].some(x=>tk.includes(x))) return 'Z';
  if (['running','trail'].some(x=>tk.includes(x)))                  return 'R';
  return 'OTHER';
}

function fmtTime(sec) {
  if (!sec) return null;
  return `${Math.floor(sec/60)}:${String(Math.floor(sec%60)).padStart(2,'0')}`;
}
