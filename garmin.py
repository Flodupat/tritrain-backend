from http.server import BaseHTTPRequestHandler
import json, urllib.parse
from datetime import datetime, timedelta, date

try:
    from garminconnect import Garmin
except ImportError:
    Garmin = None

def cors_headers():
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Content-Type": "application/json",
    }

def error(msg, status=400):
    return {"statusCode": status, "headers": cors_headers(), "body": json.dumps({"error": msg})}

def ok(data):
    return {"statusCode": 200, "headers": cors_headers(), "body": json.dumps(data, default=str)}

def handler(request):
    if request.method == "OPTIONS":
        return {"statusCode": 200, "headers": cors_headers(), "body": ""}

    path   = request.path
    params = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(request.url).query))

    # POST /api/garmin/auth  — teste les identifiants
    if path == "/api/garmin/auth":
        if request.method != "POST":
            return error("POST required")
        try:
            body     = json.loads(request.body)
            email    = body.get("email","").strip()
            password = body.get("password","").strip()
            if not email or not password:
                return error("Email et mot de passe requis")
            if Garmin is None:
                return error("garminconnect non installé", 500)
            client = Garmin(email, password)
            client.login()
            name = client.get_full_name()
            return ok({"success": True, "name": name})
        except Exception as e:
            return error(f"Connexion échouée : {e}", 401)

    # GET /api/garmin/activities?email=&password=&days=14
    elif path == "/api/garmin/activities":
        email    = params.get("email","")
        password = params.get("password","")
        days     = int(params.get("days","14"))
        if not email or not password:
            return error("email/password requis")
        if Garmin is None:
            return error("garminconnect non installé", 500)
        try:
            client = Garmin(email, password)
            client.login()
            end   = datetime.now()
            start = end - timedelta(days=days)
            raw = client.get_activities_by_date(
                start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d"))
            activities = []
            for a in raw:
                tk    = a.get("activityType",{}).get("typeKey","")
                sport = _map_sport(tk)
                dur_s = a.get("duration", 0)
                dist  = a.get("distance", 0)
                swim_pace = None
                if sport == "S" and dist and dur_s:
                    swim_pace = _fmt_swim(round((dur_s / dist) * 100, 1))
                activities.append({
                    "id":        a.get("activityId"),
                    "date":      a.get("startTimeLocal","")[:10],
                    "name":      a.get("activityName",""),
                    "sport":     sport,
                    "sportRaw":  tk,
                    "duration":  round(dur_s / 60, 1),
                    "distance":  round(dist / 1000, 2),
                    "avgHR":     a.get("averageHR"),
                    "maxHR":     a.get("maxHR"),
                    "avgPower":  a.get("avgPower"),
                    "normPower": a.get("normPower"),
                    "avgPace":   _pace(a.get("averageSpeed"), sport),
                    "swimPace":  swim_pace,
                    "calories":  a.get("calories"),
                    "tss":       a.get("trainingStressScore"),
                })
            return ok({"activities": activities, "count": len(activities)})
        except Exception as e:
            return error(str(e), 500)

    # GET /api/garmin/stats?email=&password=
    elif path == "/api/garmin/stats":
        email    = params.get("email","")
        password = params.get("password","")
        if not email or not password:
            return error("email/password requis")
        if Garmin is None:
            return error("garminconnect non installé", 500)
        try:
            client = Garmin(email, password)
            client.login()
            today      = date.today()
            week_start = (today - timedelta(days=today.weekday())).isoformat()
            raw = client.get_activities_by_date(
                (today - timedelta(days=30)).isoformat(), today.isoformat())

            weekly = {"swim":0,"zwift":0,"run":0,"total":0}
            powers, paces, swims = [], [], []

            for a in raw:
                tk    = a.get("activityType",{}).get("typeKey","")
                sport = _map_sport(tk)
                dur   = a.get("duration",0) / 60
                adate = a.get("startTimeLocal","")[:10]
                if adate >= week_start:
                    if sport=="S": weekly["swim"]  += dur
                    elif sport=="Z": weekly["zwift"] += dur
                    elif sport=="R": weekly["run"]   += dur
                    weekly["total"] += dur
                if sport=="Z" and a.get("avgPower") and len(powers)<5:
                    powers.append(a.get("normPower") or a.get("avgPower"))
                if sport=="R" and a.get("averageSpeed") and len(paces)<5:
                    paces.append(1000/a["averageSpeed"])
                if sport=="S":
                    d2, t2 = a.get("distance",0), a.get("duration",0)
                    if d2 and t2 and len(swims)<5:
                        swims.append((t2/d2)*100)

            return ok({
                "weekly":      {k: round(v) for k,v in weekly.items()},
                "avgPower":    round(sum(powers)/len(powers)) if powers else None,
                "avgPaceFmt":  _fmt_pace(sum(paces)/len(paces)) if paces else None,
                "avgSwimFmt":  _fmt_swim(sum(swims)/len(swims)) if swims else None,
            })
        except Exception as e:
            return error(str(e), 500)

    return error("Route inconnue", 404)

def _map_sport(tk):
    tk = tk.lower()
    if "swim" in tk: return "S"
    if any(x in tk for x in ["cycling","indoor","virtual","zwift"]): return "Z"
    if any(x in tk for x in ["running","trail"]): return "R"
    return "OTHER"

def _pace(spd, sport):
    if not spd or spd<=0 or sport!="R": return None
    return _fmt_pace(1000/spd)

def _fmt_pace(sec):
    if not sec: return None
    return f"{int(sec//60)}:{int(sec%60):02d}"

def _fmt_swim(sec):
    if not sec: return None
    return f"{int(sec//60)}:{int(sec%60):02d}"
