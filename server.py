# -*- coding: utf-8 -*-
"""零依赖 HTTP 服务：REST API + 静态前端。运行：python3 server.py [port]"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import correlation as corr
from db import SYMPTOMS, ZONES, init_db, get_conn, clear_business_data, seed_demo_events

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")

VALID_SEVERITIES = {"info", "warn", "critical"}


# ---------------- 序列化 ----------------
def events_json(conn, rows):
    """批量序列化事件，房间/设备/簇信息一次性预取，避免大数据量下的 N+1 查询"""
    rows = list(rows)
    if not rows:
        return []
    dev_ids = list({r["device_id"] for r in rows})
    room_ids = list({r["room_id"] for r in rows})
    cids = [r["cluster_id"] for r in rows if r["cluster_id"] is not None]
    ph_d = ",".join("?" * len(dev_ids))
    ph_r = ",".join("?" * len(room_ids))
    devs = {r["id"]: r for r in conn.execute(
        f"SELECT id,name,type FROM devices WHERE id IN ({ph_d})", dev_ids).fetchall()}
    rooms = {r["id"]: r for r in conn.execute(
        f"SELECT id,name,zone,zone_name FROM rooms WHERE id IN ({ph_r})", room_ids).fetchall()}
    clusters = {}
    if cids:
        ph_c = ",".join("?" * len(cids))
        clusters = {r["id"]: r for r in conn.execute(
            f"SELECT id,name,diagnosis FROM clusters WHERE id IN ({ph_c})", cids).fetchall()}

    out = []
    for r in rows:
        d = dict(r)
        dev = devs.get(d["device_id"])
        room = rooms.get(d["room_id"])
        c = clusters.get(d["cluster_id"])
        d["device_name"] = dev["name"] if dev else d["device_id"]
        d["device_type"] = dev["type"] if dev else None
        d["room_name"] = room["name"] if room else d["room_id"]
        d["zone"] = room["zone"] if room else None
        d["zone_name"] = room["zone_name"] if room else None
        d["merge_reason"] = json.loads(d["merge_reason"]) if d["merge_reason"] else None
        d["symptom_name"] = corr.canonical(d["symptom"])
        if c:
            d["cluster_name"] = c["name"]
            diag = json.loads(c["diagnosis"]) if c["diagnosis"] else None
            d["verdict"] = diag["verdict"] if diag else ""
            d["verdict_key"] = diag["verdict_key"] if diag else None
        out.append(d)
    return out


def event_json(conn, r):
    return events_json(conn, [r])[0]


def cluster_brief(conn, c):
    members = conn.execute("SELECT * FROM events WHERE cluster_id=? ORDER BY ts", (c["id"],)).fetchall()
    diag = json.loads(c["diagnosis"]) if c["diagnosis"] else None
    return {
        "id": c["id"],
        "name": c["name"],
        "status": c["status"],
        "created_manually": c["created_manually"],
        "locked": c["locked"],
        "event_count": len(members),
        "room_count": len({m["room_id"] for m in members}),
        "device_count": len({m["device_id"] for m in members}),
        "first_ts": members[0]["ts"] if members else None,
        "last_ts": members[-1]["ts"] if members else None,
        "max_severity": "critical" if any(m["severity"] == "critical" for m in members)
        else ("warn" if any(m["severity"] == "warn" for m in members) else "info"),
        "symptom": members[0]["symptom"] if members else None,
        "symptom_name": corr.canonical(members[0]["symptom"]) if members else "",
        "verdict": diag["verdict"] if diag else "",
        "verdict_key": diag["verdict_key"] if diag else None,
        "confidence": diag["confidence"] if diag else None,
    }


# ---------------- API 处理 ----------------
def api_route(method, path, qs, body):
    conn = get_conn()
    try:
        if method == "GET" and path == "/api/meta":
            return meta(conn)
        if method == "GET" and path == "/api/topology":
            return topology(conn, qs)
        if method == "GET" and path == "/api/overview":
            return overview(conn)
        if method == "GET" and path == "/api/events":
            return list_events(conn, qs)
        if method == "POST" and path == "/api/events":
            return create_event(conn, body)
        if method == "GET" and path == "/api/clusters":
            return list_clusters(conn, qs)
        if method == "GET" and path.startswith("/api/clusters/") and path.endswith("/audit"):
            cid = int(path.split("/")[3])
            rows = conn.execute("SELECT * FROM audit_log WHERE cluster_id=? ORDER BY id DESC", (cid,)).fetchall()
            return {"items": [dict(r) for r in rows]}
        if method == "GET" and path.startswith("/api/clusters/"):
            cid = int(path.split("/")[3])
            return cluster_detail(conn, cid)
        if method == "POST" and path == "/api/clusters/merge":
            cid, diag = corr.manual_merge(conn, body.get("cluster_ids", []),
                                          body.get("event_ids", []), body.get("reason", ""))
            return {"cluster_id": cid, "diagnosis": diag}
        if method == "POST" and path.endswith("/split"):
            cid = int(path.split("/")[3])
            new_id = corr.split_cluster(conn, cid, body.get("event_ids", []), body.get("reason", ""))
            return {"new_cluster_id": new_id}
        if method == "POST" and path.endswith("/lock"):
            cid = int(path.split("/")[3])
            corr.set_lock(conn, cid, bool(body.get("locked")), body.get("reason", ""))
            return {"ok": True}
        if method == "POST" and path.endswith("/status"):
            cid = int(path.split("/")[3])
            corr.set_status(conn, cid, body.get("status", "active"), body.get("reason", ""))
            return {"ok": True}
        if method == "POST" and path == "/api/recompute":
            return corr.recompute(conn)
        if method == "GET" and path == "/api/settings":
            return corr.get_settings(conn)
        if method == "PUT" and path == "/api/settings":
            return update_settings(conn, body)
        if method == "POST" and path == "/api/seed":
            clear_business_data(conn)
            results = seed_demo_events(lambda *a, **k: corr.create_event(conn, **k))
            audit_rows = conn.execute("SELECT COUNT(*) c FROM audit_log").fetchone()
            return {"created": len(results), "audit_rows": audit_rows["c"]}
        if method == "POST" and path == "/api/reset":
            clear_business_data(conn)
            return {"ok": True}
        if method == "GET" and path == "/api/audit":
            rows = conn.execute("SELECT * FROM audit_log ORDER BY id DESC LIMIT 200").fetchall()
            return {"items": [dict(r) for r in rows]}
        if method == "GET" and path == "/api/blocks":
            rows = conn.execute("""SELECT b.*, e1.ts AS a_ts, e2.ts AS b_ts,
                                          d1.name AS a_dev, d2.name AS b_dev
                                   FROM merge_blocks b
                                   JOIN events e1 ON e1.id=b.event_a
                                   JOIN events e2 ON e2.id=b.event_b
                                   JOIN devices d1 ON d1.id=e1.device_id
                                   JOIN devices d2 ON d2.id=e2.device_id
                                   ORDER BY b.id DESC""").fetchall()
            return {"items": [dict(r) for r in rows]}
        raise ApiError(404, "接口不存在")
    finally:
        conn.close()


class ApiError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code


def meta(conn):
    rooms = [dict(r) for r in conn.execute("SELECT * FROM rooms ORDER BY id").fetchall()
             if not r["id"].startswith("Z-")]
    devices = [dict(r) for r in conn.execute("SELECT * FROM devices ORDER BY id").fetchall()]
    return {
        "symptoms": [{"id": k, "name": v[0], "upstream": v[1], "aliases": v[2]}
                     for k, v in SYMPTOMS.items()],
        "zones": [{"id": z[0], "name": z[1], "rooms": z[2]} for z in ZONES],
        "rooms": rooms,
        "devices": devices,
        "settings": corr.get_settings(conn),
    }


def topology(conn, qs):
    nodes = [dict(r) for r in conn.execute("SELECT * FROM devices ORDER BY id").fetchall()]
    edges = [[n["id"], n["parent_id"]] for n in nodes if n["parent_id"]]
    highlight = set()
    suspect = set()
    cid = qs.get("cluster", [None])[0]
    diag = None
    if cid:
        c = conn.execute("SELECT diagnosis FROM clusters WHERE id=?", (cid,)).fetchone()
        if c and c["diagnosis"]:
            diag = json.loads(c["diagnosis"])
            highlight = set(diag["highlight"])
            suspect = {s["id"] for s in diag["suspects"]}
    event_counts = {}
    rows = conn.execute("""SELECT device_id, COUNT(*) c FROM events
                           WHERE cluster_id IS NOT NULL GROUP BY device_id""").fetchall()
    for r in rows:
        event_counts[r["device_id"]] = r["c"]
    for n in nodes:
        n["highlight"] = n["id"] in highlight
        n["suspect"] = n["id"] in suspect
        n["event_count"] = event_counts.get(n["id"], 0)
    return {"nodes": nodes, "edges": edges, "diagnosis": diag}


def overview(conn):
    total = conn.execute("SELECT COUNT(*) c FROM events").fetchone()["c"]
    active = conn.execute("SELECT COUNT(*) c FROM clusters WHERE status='active'").fetchone()["c"]
    multi_room = conn.execute("""SELECT COUNT(*) c FROM clusters cl WHERE cl.status='active' AND (
        SELECT COUNT(DISTINCT room_id) FROM events WHERE cluster_id=cl.id) > 1""").fetchone()["c"]
    critical = conn.execute(
        "SELECT COUNT(*) c FROM events WHERE severity='critical'").fetchone()["c"]
    latest = conn.execute("SELECT ts FROM events ORDER BY ts DESC LIMIT 1").fetchone()
    return {"total_events": total, "active_clusters": active,
            "multi_room_clusters": multi_room, "critical_events": critical,
            "latest_ts": latest["ts"] if latest else None}


def list_events(conn, qs):
    """组合筛选 + 分页。
    条件：room / device / symptom / severity / time_from / time_to / cluster
    分页：page(从1起) / page_size(默认20，上限100)；返回 total / page / page_size / pages
    """
    def q(name):
        return qs[name][0] if name in qs and qs[name][0] != "" else None

    where, args = ["1=1"], []
    if q("cluster"):
        where.append("cluster_id=?")
        args.append(int(q("cluster")))
    if q("room"):
        where.append("room_id=?")
        args.append(q("room"))
    if q("device"):
        where.append("device_id=?")
        args.append(q("device"))
    if q("symptom"):
        if q("symptom") not in SYMPTOMS:
            raise ApiError(400, "未知异常现象")
        where.append("symptom=?")
        args.append(q("symptom"))
    if q("severity"):
        if q("severity") not in VALID_SEVERITIES:
            raise ApiError(400, "严重程度只能是 info/warn/critical")
        where.append("severity=?")
        args.append(q("severity"))
    tf, tt = q("time_from"), q("time_to")
    # 结束时间只精确到分钟时补到该分钟末，保证 "21:00" 能包含 21:00:xx 的记录
    if tf:
        validate_time(tf, "开始时间")
    if tt:
        validate_time(tt, "结束时间")
        if len(tt) == 16:
            tt = tt + ":59"
    if tf:
        where.append("ts >= ?")
        args.append(tf)
    if tt:
        where.append("ts <= ?")
        args.append(tt)

    where_sql = " AND ".join(where)
    total = conn.execute(f"SELECT COUNT(*) c FROM events WHERE {where_sql}",
                         args).fetchone()["c"]
    try:
        page = max(1, int(q("page") or 1))
        page_size = min(100, max(1, int(q("page_size") or 20)))
    except ValueError:
        raise ApiError(400, "分页参数必须是整数")
    pages = max(1, (total + page_size - 1) // page_size)
    page = min(page, pages)
    offset = (page - 1) * page_size
    rows = conn.execute(
        f"SELECT * FROM events WHERE {where_sql} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?",
        args + [page_size, offset]).fetchall()
    return {"items": events_json(conn, rows), "total": total,
            "page": page, "page_size": page_size, "pages": pages,
            "has_prev": page > 1, "has_next": page < pages}


def validate_time(s, label):
    try:
        corr.parse_ts(s)
    except ValueError:
        raise ApiError(400, f"{label}格式应为 YYYY-MM-DDTHH:MM")


def create_event(conn, body):
    required = ["ts", "room_id", "device_id", "symptom"]
    for k in required:
        if not body.get(k):
            raise ApiError(400, f"缺少字段 {k}")
    if body["symptom"] not in SYMPTOMS:
        raise ApiError(400, "未知症状类型")
    room = conn.execute("SELECT * FROM rooms WHERE id=? AND id NOT LIKE 'Z-%'",
                        (body["room_id"],)).fetchone()
    if not room:
        raise ApiError(400, "包厢不存在")
    dev = conn.execute("SELECT * FROM devices WHERE id=?", (body["device_id"],)).fetchone()
    if not dev:
        raise ApiError(400, "设备不存在")
    if dev["room_id"] != body["room_id"]:
        dev_room = conn.execute("SELECT name FROM rooms WHERE id=?",
                                (dev["room_id"],)).fetchone()
        where = dev_room["name"] if dev_room else dev["room_id"]
        raise ApiError(400, f"设备 {dev['name']} 不属于包厢 {room['name']}，"
                            f"它安装在 {where}")
    sev = body.get("severity", "warn")
    if sev not in VALID_SEVERITIES:
        sev = "warn"
    try:
        corr.parse_ts(body["ts"])
    except ValueError:
        raise ApiError(400, "时间格式应为 YYYY-MM-DDTHH:MM")
    result = corr.create_event(
        conn, ts=body["ts"], room_id=body["room_id"], device_id=body["device_id"],
        symptom=body["symptom"], severity=sev,
        description=body.get("description", ""), reporter=body.get("reporter", ""))
    result["event"] = event_json(conn, conn.execute(
        "SELECT * FROM events WHERE id=?", (result["event"]["id"],)).fetchone())
    return result


def list_clusters(conn, qs):
    sql = "SELECT * FROM clusters"
    if qs.get("status", ["active"])[0] != "all":
        sql += " WHERE status='active'"
    rows = conn.execute(sql + " ORDER BY updated_at DESC").fetchall()
    return {"items": [cluster_brief(conn, c) for c in rows]}


def cluster_detail(conn, cid):
    c = conn.execute("SELECT * FROM clusters WHERE id=?", (cid,)).fetchone()
    if not c:
        raise ApiError(404, "簇不存在")
    members = conn.execute("SELECT * FROM events WHERE cluster_id=? ORDER BY ts", (cid,)).fetchall()
    blocks = conn.execute("""SELECT * FROM merge_blocks
        WHERE event_a IN (SELECT id FROM events WHERE cluster_id=?)
           OR event_b IN (SELECT id FROM events WHERE cluster_id=?)""", (cid, cid)).fetchall()
    return {
        "cluster": cluster_brief(conn, c),
        "locked": c["locked"],
        "created_manually": c["created_manually"],
        "diagnosis": json.loads(c["diagnosis"]) if c["diagnosis"] else None,
        "events": [event_json(conn, m) for m in members],
        "blocks": [dict(b) for b in blocks],
    }


def update_settings(conn, body):
    allowed = set(corr.get_settings(conn).keys())
    for k, v in body.items():
        if k in allowed:
            conn.execute("UPDATE settings SET value=? WHERE key=?", (str(v), k))
    conn.commit()
    return corr.get_settings(conn)


# ---------------- HTTP 框架 ----------------
class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload, ctype="application/json; charset=utf-8"):
        data = payload if isinstance(payload, bytes) else json.dumps(
            payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path.startswith("/api/"):
                self._send(200, api_route("GET", path, parse_qs(parsed.query), None))
            else:
                self.serve_static(path)
        except ApiError as e:
            self._send(e.code, {"error": str(e)})
        except Exception as e:
            import traceback
            traceback.print_exc()
            self._send(500, {"error": str(e)})

    def do_POST(self):
        self._mutate("POST")

    def do_PUT(self):
        self._mutate("PUT")

    def _mutate(self, method):
        parsed = urlparse(self.path)
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) if length else b"{}"
            body = json.loads(raw.decode("utf-8") or "{}")
            self._send(200, api_route(method, parsed.path, {}, body))
        except ApiError as e:
            self._send(e.code, {"error": str(e)})
        except ValueError as e:
            self._send(400, {"error": "请求体格式错误：" + str(e)})
        except Exception as e:
            import traceback
            traceback.print_exc()
            self._send(500, {"error": str(e)})

    def serve_static(self, path):
        rel = path.lstrip("/") or "index.html"
        full = os.path.normpath(os.path.join(STATIC_DIR, rel))
        # 防目录穿越
        if not full.startswith(STATIC_DIR + os.sep):
            raise ApiError(404, "资源不存在")
        if not os.path.isfile(full):
            # 明确的静态资源后缀缺失 -> 404；无扩展名的前端路由 -> 回退 index.html
            if os.path.splitext(rel)[1] in (".js", ".css", ".png", ".jpg",
                                            ".svg", ".ico", ".woff2"):
                raise ApiError(404, "静态资源不存在")
            full = os.path.join(STATIC_DIR, "index.html")
            if not os.path.isfile(full):
                raise ApiError(404, "index.html 缺失，static 目录是否完整？")
        ctype = {"html": "text/html; charset=utf-8", "js": "application/javascript; charset=utf-8",
                 "css": "text/css; charset=utf-8"}.get(full.rsplit(".", 1)[-1], "text/plain")
        with open(full, "rb") as f:
            self._send(200, f.read(), ctype)

    def log_message(self, fmt, *args):
        sys.stderr.write("[http] " + fmt % args + "\n")


def main():
    init_db()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"设备异常记录关联台: http://localhost:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
