# -*- coding: utf-8 -*-
"""
关联引擎：相似事件归并 / 时间窗口规则 / 误合并拆分屏障 / 故障关系研判

归并三规则（必须同标准症状，且与簇内"任意一条"事件时间差在窗口内）：
  R1 同设备：        65 分起评，同设备窗口默认 60min —— 捕捉单台复发
  R2 同包厢跨设备：  55 分起评，包厢窗口默认 15min   —— 捕捉包厢级问题
  R3 跨包厢公共链路：40 分起评，公共窗口默认 5min     —— 捕捉上游/公共故障
评分叠加文本相似度、症状关键词命中、共享上游节点；>= 阈值(默认60)才合并。
"""
import json
import re
from datetime import datetime

from db import SYMPTOMS, get_conn

PUNCT = re.compile(r"[，。、；：！？,.;:!?\s\"'（）()【】\[\]<>《》—\-_/]+")


# ---------------- 基础工具 ----------------
def now_iso():
    return datetime.now().replace(microsecond=0).isoformat()


def parse_ts(s):
    return datetime.fromisoformat(s)


def get_settings(conn):
    rows = conn.execute("SELECT key, value FROM settings").fetchall()
    m = {r["key"]: r["value"] for r in rows}
    return {
        "same_device_window_min": int(m["same_device_window_min"]),
        "room_window_min": int(m["room_window_min"]),
        "public_window_min": int(m["public_window_min"]),
        "merge_threshold": int(m["merge_threshold"]),
        "offline_global_min_rooms": int(m["offline_global_min_rooms"]),
    }


def ancestor_chain(conn, device_id):
    """设备 -> ... -> 根 的祖先链（含自身）"""
    chain = []
    seen = set()
    cur = device_id
    while cur and cur not in seen:
        seen.add(cur)
        chain.append(cur)
        row = conn.execute("SELECT parent_id FROM devices WHERE id=?", (cur,)).fetchone()
        cur = row["parent_id"] if row else None
    return chain


def lca(conn, dev_a, dev_b):
    """两台设备的最近公共祖先节点 id"""
    ca = set(ancestor_chain(conn, dev_a))
    for node in ancestor_chain(conn, dev_b):
        if node in ca:
            return node
    return None


def shared_switch(conn, members_devices):
    """一组设备的最近公共交换节点（只看 switch/core）"""
    if not members_devices:
        return None
    chains = [set(ancestor_chain(conn, d)) for d in members_devices]
    common = set.intersection(*chains) if chains else set()
    dev_rows = {d["id"]: d for d in conn.execute(
        "SELECT id,type FROM devices WHERE id IN (%s)" % ",".join("?" * len(common)),
        tuple(common)).fetchall()} if common else {}
    # 按链上最近的优先：遍历第一台设备的链
    for node in ancestor_chain(conn, members_devices[0]):
        if node in common and node in dev_rows and dev_rows[node]["type"] in ("switch", "core"):
            return node
    return None


def bigrams(text):
    t = PUNCT.sub("", text or "")
    if len(t) <= 1:
        return {t} if t else set()
    return {t[i:i + 2] for i in range(len(t) - 1)}


def text_sim(a, b):
    """字符二元组 Jaccard 相似度 0~1"""
    ba, bb = bigrams(a), bigrams(b)
    if not ba or not bb:
        return 0.0
    return len(ba & bb) / len(ba | bb)


def alias_hit(symptom, text):
    for alias in SYMPTOMS[symptom][2]:
        if alias and alias in (text or ""):
            return True
    return False


def canonical(symptom):
    return SYMPTOMS.get(symptom, SYMPTOMS["other"])[0]


def is_blocked(conn, eid_a, eid_b):
    row = conn.execute(
        "SELECT 1 FROM merge_blocks WHERE event_a=? AND event_b=?",
        (min(eid_a, eid_b), max(eid_a, eid_b))).fetchone()
    return row is not None


def add_block(conn, a, b, reason):
    conn.execute(
        "INSERT OR IGNORE INTO merge_blocks(event_a,event_b,reason,created_at) VALUES(?,?,?,?)",
        (min(a, b), max(a, b), reason, now_iso()))


def audit(conn, action, cluster_id=None, event_id=None, detail=""):
    conn.execute(
        "INSERT INTO audit_log(ts,action,cluster_id,event_id,detail) VALUES(?,?,?,?,?)",
        (now_iso(), action, cluster_id, event_id, detail))


# ---------------- 匹配评分 ----------------
def score_pair(conn, ev, ref, settings):
    """对新事件 ev 与候选簇中一条参照事件 ref 评分，返回 (rule, score, lca_node) 或 None"""
    if ev["symptom"] != ref["symptom"]:
        return None
    gap = abs((parse_ts(ev["ts"]) - parse_ts(ref["ts"])).total_seconds()) / 60.0

    sim = text_sim(ev["description"], ref["description"])
    both_alias = alias_hit(ev["symptom"], ev["description"]) and alias_hit(
        ref["symptom"], ref["description"])
    alias_bonus = 10 if both_alias else 0

    # R1 同设备
    if ev["device_id"] == ref["device_id"]:
        if gap <= settings["same_device_window_min"]:
            score = min(100, 65 + 25 * sim + alias_bonus)
            return "R1", score, gap, ev["device_id"]
        return None

    # R2 同包厢跨设备
    if ev["room_id"] == ref["room_id"]:
        if gap <= settings["room_window_min"]:
            score = min(100, 55 + 25 * sim + alias_bonus)
            return "R2", score, gap, None
        return None

    # R3 跨包厢：必须有公共上游
    node = lca(conn, ev["device_id"], ref["device_id"])
    if not node:
        return None
    node_type = conn.execute("SELECT type FROM devices WHERE id=?", (node,)).fetchone()["type"]
    zone_bonus = 20 if node_type == "switch" else 0
    service_bonus = 15 if SYMPTOMS[ev["symptom"]][1] else 0
    if gap <= settings["public_window_min"]:
        # 离线类额外门槛：不共享区域交换机时，需达到全局汇聚规模
        if ev["symptom"] == "offline" and node_type != "switch":
            return None
        score = min(100, 40 + 25 * sim + zone_bonus + service_bonus + alias_bonus)
        return "R3", score, gap, node
    return None


def find_candidate_cluster(conn, ev, settings):
    """在已有簇中找最佳归并目标，返回 (cluster_row, rule, score, gap, ref_event, lca_node)"""
    candidates = conn.execute(
        """SELECT c.* FROM clusters c
           WHERE c.status='active' AND c.locked=0
             AND EXISTS (SELECT 1 FROM events e2
                         WHERE e2.cluster_id=c.id AND e2.symptom=?)""",
        (ev["symptom"],)).fetchall()
    best = None
    for c in candidates:
        members = conn.execute(
            "SELECT * FROM events WHERE cluster_id=? ORDER BY ts", (c["id"],)).fetchall()
        # 拆分屏障：与簇内任一成员存在屏障则不能并入
        if any(is_blocked(conn, ev["id"], m["id"]) for m in members):
            continue
        # 跨包厢离线汇聚需达到全局最少包厢数
        for ref in members:
            scored = score_pair(conn, ev, ref, settings)
            if not scored:
                continue
            rule, score, gap, node = scored
            if score >= settings["merge_threshold"] and (best is None or score > best[2]):
                best = (c, rule, score, gap, ref, node)
    return best


# ---------------- 簇生命周期 ----------------
def create_cluster(conn, name="", manual=0):
    ts = now_iso()
    cur = conn.execute(
        "INSERT INTO clusters(name,status,created_manually,locked,created_at,updated_at)"
        " VALUES(?,?,0,0,?,?)", (name, "active", ts, ts))
    return cur.lastrowid


def diagnose_cluster(conn, cluster_id):
    """研判：单台故障 / 包厢本地问题 / 区域链路 / 公共服务 / 核心链路"""
    members = conn.execute(
        "SELECT * FROM events WHERE cluster_id=? ORDER BY ts", (cluster_id,)).fetchall()
    if not members:
        return None
    symptom = members[0]["symptom"]
    sym_name = canonical(symptom)
    server_id = SYMPTOMS[symptom][1]
    rooms = sorted({m["room_id"] for m in members})
    devices = sorted({m["device_id"] for m in members})
    dev_rows = {d["id"]: d for d in conn.execute(
        "SELECT * FROM devices WHERE id IN (%s)" % ",".join("?" * len(devices)),
        tuple(devices)).fetchall()}
    zones = {dev_rows[d]["room_id"] and
             conn.execute("SELECT zone FROM rooms WHERE id=?",
                          (dev_rows[d]["room_id"],)).fetchone()["zone"]
             for d in devices if dev_rows[d]["room_id"]}
    zones.discard(None)
    span = (parse_ts(members[-1]["ts"]) - parse_ts(members[0]["ts"])).total_seconds() / 60.0

    suspects = []          # [(device_id, role)]
    rationale = []

    def paths_for(node_ids):
        """高亮节点：疑似节点本身+祖先，以及簇内设备到疑似节点的路径"""
        hl = set()
        for sid in node_ids:
            hl.update(ancestor_chain(conn, sid))
        for d in devices:
            chain = ancestor_chain(conn, d)
            for node in chain:
                hl.add(node)
                if node in node_ids:
                    break
        return sorted(hl)

    n = len(members)
    if len(devices) == 1:
        key, title = "single_device", "单台设备故障"
        confidence = 0.85 if n >= 3 else 0.7
        did = devices[0]
        suspects = [(did, "primary")]
        rationale.append(f"全部 {n} 条记录都指向同一台设备 {dev_rows[did]['name']}")
        if n >= 3:
            rationale.append(f"{span:.0f} 分钟内复发 {n} 次，呈间歇性故障特征")
        highlight = paths_for({did})

    elif len(rooms) == 1:
        key, title = "room_local", "包厢本地问题（非公共链路）"
        confidence = 0.7
        room_name = conn.execute("SELECT name FROM rooms WHERE id=?", (rooms[0],)).fetchone()["name"]
        dnames = "、".join(dev_rows[d]["name"] for d in devices)
        rationale.append(f"事件集中在 {room_name}，涉及 {len(devices)} 台设备：{dnames}")
        if symptom == "howl":
            rationale.append("啸叫同时出现在话筒与功放，优先排查摆位、增益与反馈抑制")
        suspects = [(d, "primary") for d in devices]
        highlight = paths_for(set(devices))

    else:
        switch = shared_switch(conn, devices)
        sw_type = conn.execute("SELECT type FROM devices WHERE id=?", (switch,)).fetchone()["type"] \
            if switch else None
        same_zone = len(zones) == 1 and sw_type == "switch"

        if server_id:
            key = "public_service"
            title = f"疑似{conn.execute('SELECT name FROM devices WHERE id=?', (server_id,)).fetchone()['name']}故障"
            confidence = 0.85 if len(rooms) >= 3 else 0.65
            suspects = [(server_id, "primary")]
            rationale.append(f"{len(rooms)} 个包厢在相近时间出现同类「{sym_name}」")
            if same_zone:
                suspects.append((switch, "secondary"))
                zname = conn.execute("SELECT name FROM devices WHERE id=?",
                                     (switch,)).fetchone()["name"]
                rationale.append(f"所有包厢同在 {zname} 下，也不能排除该交换机")
            else:
                rationale.append("包厢分布在不同区域，本地交换节点不可能同时影响它们")
            highlight = paths_for({s for s, _ in suspects})
        elif symptom == "offline" and same_zone:
            key = "zone_link"
            title = f"疑似区域链路故障：{conn.execute('SELECT name FROM devices WHERE id=?', (switch,)).fetchone()['name']}"
            confidence = 0.9
            suspects = [(switch, "primary")]
            rationale.append(f"同区域 {len(rooms)} 个包厢短时集体离线")
            highlight = paths_for({switch})
        else:
            key = "core_link"
            title = "疑似核心链路故障"
            confidence = 0.55
            core = switch if sw_type == "core" else "CORE-01"
            suspects = [(core, "primary")]
            rationale.append(f"{len(rooms)} 个跨区域包厢出现同类现象，汇聚到核心层")
            highlight = paths_for({core})

    # 簇名
    if len(devices) == 1:
        rn = conn.execute("SELECT name FROM rooms WHERE id=?", (rooms[0],)).fetchone()["name"]
        name = f"{rn}{dev_rows[devices[0]]['name'].replace(rooms[0],'')}·{sym_name} ×{n}"
    elif len(rooms) == 1:
        rn = conn.execute("SELECT name FROM rooms WHERE id=?", (rooms[0],)).fetchone()["name"]
        name = f"{rn}·{sym_name}（{len(devices)}台设备/{n}条）"
    else:
        name = f"{sym_name} · {len(rooms)}个包厢/{n}条"

    result = {
        "verdict_key": key,
        "verdict": title,
        "confidence": confidence,
        "suspects": [{"id": s, "role": r,
                      "name": conn.execute("SELECT name FROM devices WHERE id=?", (s,)).fetchone()["name"]}
                     for s, r in suspects],
        "rationale": rationale,
        "room_ids": rooms,
        "device_ids": devices,
        "highlight": highlight,
        "span_min": round(span, 1),
        "count": n,
    }
    conn.execute("UPDATE clusters SET diagnosis=?, name=?, updated_at=? WHERE id=?",
                 (json.dumps(result, ensure_ascii=False), name, now_iso(), cluster_id))
    return result


# ---------------- 事件录入 ----------------
def create_event(conn, *, ts, room_id, device_id, symptom, severity="warn",
                 description="", reporter=""):
    cur = conn.execute(
        "INSERT INTO events(ts,room_id,device_id,symptom,severity,description,reporter,created_at)"
        " VALUES(?,?,?,?,?,?,?,?)",
        (ts, room_id, device_id, symptom, severity, description, reporter, now_iso()))
    ev_id = cur.lastrowid
    ev = conn.execute("SELECT * FROM events WHERE id=?", (ev_id,)).fetchone()
    settings = get_settings(conn)
    match = find_candidate_cluster(conn, ev, settings)

    if match:
        cluster, rule, score, gap, ref, node = match
        conn.execute("UPDATE events SET cluster_id=?, merge_reason=? WHERE id=?",
                     (cluster["id"],
                      json.dumps({
                          "rule": rule, "score": round(score, 1),
                          "ref_event_id": ref["id"], "gap_min": round(gap, 1),
                          "shared_node": node,
                          "detail": {
                              "R1": "同一台设备，同症状，在单台复发窗口内",
                              "R2": "同一包厢、同类现象，在包厢时间窗内",
                              "R3": "跨包厢同类现象，共享上游节点且在公共链路窗口内",
                          }[rule],
                      }, ensure_ascii=False),
                      ev_id))
        conn.execute("UPDATE clusters SET updated_at=? WHERE id=?", (now_iso(), cluster["id"]))
        diag = diagnose_cluster(conn, cluster["id"])
        audit(conn, "auto_merge", cluster["id"], ev_id,
              f"按 {rule} 以 {score:.0f} 分并入簇#{cluster['id']}（参照事件#{ref['id']}，相隔{gap:.1f}分钟）")
        conn.commit()
        return {"event": dict(ev), "cluster_id": cluster["id"], "diagnosis": diag}

    cid = create_cluster(conn)
    conn.execute("UPDATE events SET cluster_id=? WHERE id=?", (cid, ev_id))
    diag = diagnose_cluster(conn, cid)
    audit(conn, "create_cluster", cid, ev_id, f"未找到可关联事件，新建簇#{cid}")
    conn.commit()
    return {"event": dict(ev), "cluster_id": cid, "diagnosis": diag}


# ---------------- 人工：拆分 / 合并 / 锁定 ----------------
def split_cluster(conn, cluster_id, event_ids, reason=""):
    """把 event_ids 从簇中拆出成新簇，并在两组事件之间建立拆分屏障"""
    members = conn.execute(
        "SELECT id FROM events WHERE cluster_id=?", (cluster_id,)).fetchall()
    member_ids = [m["id"] for m in members]
    move = [e for e in event_ids if e in member_ids]
    stay = [e for e in member_ids if e not in move]
    if not move:
        raise ValueError("没有可拆分的事件")

    for a in move:
        for b in stay:
            add_block(conn, a, b, reason or "人工拆分")

    new_cid = None
    if stay:
        new_cid = create_cluster(conn)
        conn.execute("UPDATE events SET cluster_id=? WHERE id IN (%s)"
                     % ",".join("?" * len(move)), tuple([new_cid] + move))
        audit(conn, "split", new_cid, None,
              f"从簇#{cluster_id}拆出 {len(move)} 条事件（{reason}），已建立归并屏障")
        diagnose_cluster(conn, new_cid)
    else:
        # 全拆：移动的事件各自独立成簇
        first = True
        for eid in move:
            if first:
                new_cid = create_cluster(conn)
                conn.execute("UPDATE events SET cluster_id=? WHERE id=?", (new_cid, eid))
                first = False
            else:
                c2 = create_cluster(conn)
                conn.execute("UPDATE events SET cluster_id=? WHERE id=?", (c2, eid))
                diagnose_cluster(conn, c2)
        audit(conn, "split", cluster_id, None,
              f"簇#{cluster_id}被全部拆分（{reason}），已建立归并屏障")

    conn.execute("DELETE FROM clusters WHERE id=? AND NOT EXISTS"
                 " (SELECT 1 FROM events WHERE cluster_id=?)", (cluster_id, cluster_id))
    if stay:
        diagnose_cluster(conn, cluster_id)
    conn.commit()
    return new_cid


def manual_merge(conn, cluster_ids, event_ids=None, reason=""):
    """人工合并多个簇（及游离事件）为一个手动簇，不加屏障"""
    cids = [c for c in cluster_ids]
    eids = list(event_ids or [])
    all_events = []
    for cid in cids:
        all_events += [r["id"] for r in conn.execute(
            "SELECT id FROM events WHERE cluster_id=?", (cid,)).fetchall()]
    all_events += eids
    if len(set(all_events)) < 2:
        raise ValueError("至少需要两条事件才能合并")

    new_cid = create_cluster(conn, manual=1)
    qmarks = ",".join("?" * len(all_events))
    conn.execute(f"UPDATE events SET cluster_id=? WHERE id IN ({qmarks})",
                 tuple([new_cid] + all_events))
    for cid in cids:
        conn.execute("DELETE FROM clusters WHERE id=? AND NOT EXISTS"
                     " (SELECT 1 FROM events WHERE cluster_id=?)", (cid, cid))
    reason_text = reason or "人工合并"
    for eid in all_events:
        conn.execute("UPDATE events SET merge_reason=? WHERE id=?",
                     (json.dumps({"rule": "MANUAL", "detail": reason_text},
                                 ensure_ascii=False), eid))
    audit(conn, "manual_merge", new_cid, None,
          f"人工合并簇 {cids} 与事件 {eids}（{reason_text}）")
    diag = diagnose_cluster(conn, new_cid)
    conn.commit()
    return new_cid, diag


def set_lock(conn, cluster_id, locked, reason=""):
    conn.execute("UPDATE clusters SET locked=?, updated_at=? WHERE id=?",
                 (1 if locked else 0, now_iso(), cluster_id))
    audit(conn, "lock" if locked else "unlock", cluster_id, None,
          reason or ("锁定簇，自动关联不再改动" if locked else "解除锁定"))
    conn.commit()


def set_status(conn, cluster_id, status, reason=""):
    conn.execute("UPDATE clusters SET status=?, updated_at=? WHERE id=?",
                 (status, now_iso(), cluster_id))
    audit(conn, "close" if status == "closed" else "reopen", cluster_id, None,
          reason or ("标记关闭" if status == "closed" else "重新打开"))
    conn.commit()


# ---------------- 全量重算（尊重拆分屏障与手动簇） ----------------
def recompute(conn):
    settings = get_settings(conn)
    protected = [r["id"] for r in conn.execute(
        "SELECT id FROM clusters WHERE created_manually=1 OR locked=1").fetchall()]
    # 删除非保护簇，其事件改为游离；手动簇/锁定簇内事件原样保留
    if protected:
        conn.execute("DELETE FROM clusters WHERE id NOT IN (%s)"
                     % ",".join("?" * len(protected)), tuple(protected))
    else:
        conn.execute("DELETE FROM clusters")
    conn.execute("UPDATE events SET cluster_id=NULL "
                 "WHERE cluster_id IS NULL OR cluster_id NOT IN (SELECT id FROM clusters)")
    unassigned = conn.execute(
        "SELECT * FROM events WHERE cluster_id IS NULL ORDER BY ts,id").fetchall()
    moved = 0
    for ev in unassigned:
        match = find_candidate_cluster(conn, ev, settings)
        if match:
            cluster, rule, score, gap, ref, node = match
            conn.execute("UPDATE events SET cluster_id=?, merge_reason=? WHERE id=?",
                         (cluster["id"],
                          json.dumps({
                              "rule": rule, "score": round(score, 1),
                              "ref_event_id": ref["id"], "gap_min": round(gap, 1),
                              "shared_node": node,
                              "detail": {"R1": "同一台设备，同症状，在单台复发窗口内",
                                         "R2": "同一包厢、同类现象，在包厢时间窗内",
                                         "R3": "跨包厢同类现象，共享上游节点且在公共链路窗口内"}[rule],
                              "recompute": True,
                          }, ensure_ascii=False), ev["id"]))
            conn.execute("UPDATE clusters SET updated_at=? WHERE id=?", (now_iso(), cluster["id"]))
            diagnose_cluster(conn, cluster["id"])
            audit(conn, "auto_merge", cluster["id"], ev["id"],
                  f"重算：按 {rule} 以 {score:.0f} 分并入簇#{cluster['id']}")
            moved += 1
        else:
            cid = create_cluster(conn)
            conn.execute("UPDATE events SET cluster_id=? WHERE id=?", (cid, ev["id"]))
            diagnose_cluster(conn, cid)
    for cid in protected:
        diagnose_cluster(conn, cid)
    audit(conn, "recompute", None, None,
          f"全量重算完成，{moved} 条事件被重新归并；手动簇/锁定簇与拆分屏障均保留")
    conn.commit()
    return {"remerged": moved, "protected_clusters": sorted(protected)}
