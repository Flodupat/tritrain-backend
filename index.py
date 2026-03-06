from http.server import BaseHTTPRequestHandler
import json, urllib.parse
from datetime import datetime, timedelta, date

try:
    from garminconnect import Garmin
except ImportError:
    Garmin = None


def cors():
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Content-Type": "application/json",
    }


class handler(BaseHTTPRequestHandler):

    def log_message(self, format, *args):
        pass

    def send_json(self, status, data):
        body = json.dumps(data, default=str).encode()
        self.send_response(status)
        for k, v in cors().items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        for k, v in cors().items():
            self.send_header(k, v)
        self.end_headers()

    def do_POST(self):
        path   = urllib.parse.urlparse(self.path).path
        length = int(self.headers.get("Content-Length", 0))
        body   = json.loads(self.rfile.read(length)) if length else {}

        if path == "/api/garmin/auth":
            email    = body.get("email", "").strip()
            password = body.get("password", "").strip()
            if not email or not password:
                return self.send_json(400, {"error": "Email et mot de passe requis"})
            if Garmin is None:
                return self.send_json(500, {"error": "garminconnect non installe"})
            try:
                client = Garmin(email, password)
                client.login()
                name = client.get_full_name()
                self.send_json(200, {"success": True, "name": name})
            except Exception as e:
                self.send_json(401, {"error": f"Connexion echouee : {e}"})
        else:
            self.send_json(404, {"error": "Route inconnue"})

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path   = parsed.path
        params = dict(urllib.parse.parse_qsl(parsed.query))
        email    = params.get("email", "")
        password = params.get("password", "")

        if Garmin is None:
            return self.send_json(500, {"error": "garminconnect non installe"})
        if not email or not password:
            return self.send_json(400, {"error": "email et password requis"})

        try:
            client = Garmin(email, password)
            client.login()
        except Exception as e:
            return self.send_json(401, {"error": f"Connexion echouee : {e}"})

        if path == "/api/garmin/activities":
            days = int(params.get("days", "14"))
            try:
                end   = datetime.now()
                start = end - timedelta(days=days)
                raw   = client.get_activities_by_date(
                    start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d"))
                activities = []
                for a in raw:
                    tk    = a.get("activityType", {}).get("typeKey", "")
                    sport = _map(tk)
                    dur_s = a.get("duration", 0)
                    dist  = a.get("distance", 0)
                    swim  = None
                    if sport == "S" and dist and dur_s:
                        swim = _fmt_swim((dur_s / dist) * 100)
                    activities.append({
                        "id":        a.get("activityId"),
                        "date":      a.get("startTimeLocal", "")[:10],
                        "name":      a.get("activityName", ""),
                        "sport":     sport,
                        "duration":  round(dur_s / 60, 1),
                        "distance":  round(dist / 1000, 2),
                        "avgHR":     a.get("averageHR"),
                        "maxHR":     a.get("maxHR"),
                        "avgPower":  a.get("avgPower"),
                        "normPower": a.get("normPower"),
                        "avgPace":   _pace(a.get("averageSpeed"), sport),
                        "swimPace":  swim,
                        "calories":  a.get("calories"),
                    })
                self.send_json(200, {"activities": activities, "count": len(activities)})
            except Exception as e:
                self.send_json(500, {"error": str(e)})

        elif path == "/api/garmin/stats":
            try:
                today      = date.today()
                week_start = (today - timedelta(days=today.weekday())).isoformat()
                raw = client.get_activities_by_date(
                    (today - timedelta(days=30)).isoformat(), today.isoformat())
                weekly = {"swim": 0, "zwift": 0, "run": 0, "total": 0}
                powers, paces, swims = [], [], []
                for a in raw:
                    tk    = a.get("activityType", {}).get("typeKey", "")
                    sport = _map(tk)
                    dur   = a.get("duration", 0) / 60
                    adate = a.get("startTimeLocal", "")[:10]
                    if adate >= week_start:
                        if sport == "S":   weekly["swim"]  += dur
                        elif sport == "Z": weekly["zwift"] += dur
                        elif sport == "R": weekly["run"]   += dur
                        weekly["total"] += dur
                    if sport == "Z" and a.get("avgPower") and len(powers) < 5:
                        powers.append(a.get("normPower") or a.get("avgPower"))
                    if sport == "R" and a.get("averageSpeed") and len(paces) < 5:
                        paces.append(1000 / a["averageSpeed"])
                    if sport == "S":
                        d2, t2 = a.get("distance", 0), a.get("duration", 0)
                        if d2 and t2 and len(swims) < 5:
                            swims.append((t2 / d2) * 100)
                self.send_json(200, {
                    "weekly":     {k: round(v) for k, v in weekly.items()},
                    "avgPower":   round(sum(powers) / len(powers)) if powers else None,
                    "avgPaceFmt": _fmt_pace(sum(paces) / len(paces)) if paces else None,
                    "avgSwimFmt": _fmt_swim(sum(swims) / len(swims)) if swims else None,
                })
            except Exception as e:
                self.send_json(500, {"error": str(e)})
        else:
            self.send_json(404, {"error": "Route inconnue"})


def _map(tk):
    tk = tk.lower()
    if "swim" in tk: return "S"
    if any(x in tk for x in ["cycling", "indoor", "virtual", "zwift"]): return "Z"
    if any(x in tk for x in ["running", "trail"]): return "R"
    return "OTHER"

def _pace(spd, sport):
    if not spd or spd <= 0 or sport != "R": return None
    return _fmt_pace(1000 / spd)

def _fmt_pace(sec):
    if not sec: return None
    return f"{int(sec // 60)}:{int(sec % 60):02d}"

def _fmt_swim(sec):
    if not sec: return None
    return f"{int(sec // 60)}:{int(sec % 60):02d}"
