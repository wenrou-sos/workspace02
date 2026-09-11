# -*- coding: utf-8 -*-
"""sqlite3 数据层：建表、元数据（包厢/设备拓扑）、种子数据"""
import sqlite3
from datetime import datetime

DB_PATH = "/workspace/data/anomaly.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  zone TEXT NOT NULL,
  zone_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,            -- pod/amp/mic/tv/switch/core/server
  room_id TEXT,
  parent_id TEXT,
  x REAL, y REAL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,              -- ISO8601
  room_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  symptom TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warn',   -- info/warn/critical
  description TEXT NOT NULL DEFAULT '',
  reporter TEXT NOT NULL DEFAULT '',
  cluster_id INTEGER,
  merge_reason TEXT,             -- JSON: 归并依据
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_cluster ON events(cluster_id);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS clusters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',   -- active/closed
  created_manually INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  diagnosis TEXT,                -- JSON 研判结果
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 拆分屏障：两个事件不允许被自动归并到同一簇
CREATE TABLE IF NOT EXISTS merge_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_a INTEGER NOT NULL,
  event_b INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(event_a, event_b)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  action TEXT NOT NULL,
  cluster_id INTEGER,
  event_id INTEGER,
  detail TEXT NOT NULL DEFAULT ''
);
"""

DEFAULT_SETTINGS = {
    "same_device_window_min": "60",    # R1 同设备窗口
    "room_window_min": "10",           # R2 同包厢跨设备窗口
    "public_window_min": "5",          # R3 跨包厢公共链路窗口
    "merge_threshold": "60",           # 归并相似度阈值 0-100
    "offline_global_min_rooms": "3",   # 离线类跨区汇聚的最少包厢数
}

# 症状目录：id -> (标准名, 服务端疑似节点, 别名关键词)
SYMPTOMS = {
    "howl":        ("啸叫",     None,         ["啸叫", "尖叫", "回授", "反馈"]),
    "video_break": ("画面中断", "SRV-MEDIA",  ["画面中断", "黑屏", "无画面", "花屏"]),
    "song_delay":  ("点歌延迟", "SRV-SONG",   ["点歌延迟", "点歌卡", "转圈", "加载慢", "切歌慢", "搜歌"]),
    "offline":     ("设备离线", None,         ["离线", "掉线", "连不上", "断网"]),
    "mic_hum":     ("杂音/电流声", None,      ["杂音", "电流声", "嗡嗡", "底噪", "噪音"]),
    "stuck":       ("卡顿/死机/触摸异常", None, ["死机", "卡顿", "卡住", "触摸", "无响应", "没反应", "黑屏"]),
    "other":       ("其他异常", None,         []),
}

ZONES = [
    ("3FA", "三楼A区", ["K301", "K302", "K303", "K304"]),
    ("3FB", "三楼B区", ["K305", "K306", "K307", "K308"]),
    ("5FC", "五楼C区", ["K501", "K502", "K503"]),
    ("5FD", "五楼D区", ["K504", "K505", "K506"]),
]

DEVICE_KINDS = [
    ("POD", "点歌屏", "pod"),
    ("AMP", "功放", "amp"),
    ("MIC", "无线话筒", "mic"),
    ("TV", "电视", "tv"),
]


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    import os
    os.makedirs("/workspace/data", exist_ok=True)
    conn = get_conn()
    conn.executescript(SCHEMA)
    for k, v in DEFAULT_SETTINGS.items():
        conn.execute("INSERT OR IGNORE INTO settings(key, value) VALUES(?,?)", (k, v))
    conn.commit()
    if conn.execute("SELECT COUNT(*) c FROM devices").fetchone()["c"] == 0:
        seed_topology(conn)
    conn.close()


def seed_topology(conn):
    """三层拓扑：服务器/核心交换机 -> 区域交换机 -> 包厢设备。坐标手工排布给前端 SVG 用。"""
    # 固定节点
    fixed = [
        ("SRV-SONG", "点歌服务器", "server", None, "CORE-01", 90, 70),
        ("SRV-MEDIA", "媒体/中控服务器", "server", None, "CORE-01", 90, 160),
        ("CORE-01", "核心交换机", "core", None, None, 90, 300),
    ]
    for did, name, typ, room, parent, x, y in fixed:
        conn.execute("INSERT INTO devices VALUES(?,?,?,?,?,?,?)",
                     (did, name, typ, room, parent, x, y))

    zone_anchor = {
        "3FA": (380, 60),
        "3FB": (380, 760),
        "5FC": (380, 1300),
        "5FD": (380, 1750),
    }
    for zid, zname, rooms in ZONES:
        conn.execute("INSERT OR IGNORE INTO rooms(id,name,zone,zone_name) VALUES(?,?,?,?)",
                     ("Z-" + zid, zname, zid, zname))
    for zid, zname, rooms in ZONES:
        zx, zy = zone_anchor[zid]
        sw = "SW-" + zid
        conn.execute("INSERT INTO devices VALUES(?,?,?,?,?,?,?)",
                     (sw, zname + "交换机", "switch", None, "CORE-01", zx, zy + 240))
        for i, rid in enumerate(rooms):
            conn.execute("INSERT OR IGNORE INTO rooms VALUES(?,?,?,?)",
                         (rid, rid + "包厢", zid, zname))
            rx, ry = 720, zy + i * 150
            for j, (prefix, dname, dtype) in enumerate(DEVICE_KINDS):
                did = f"{prefix}-{rid[1:]}"
                dx = rx + (j % 2) * 150
                dy = ry + (j // 2) * 56
                conn.execute("INSERT INTO devices VALUES(?,?,?,?,?,?,?)",
                             (did, rid + dname, dtype, rid, sw, dx, dy))
    conn.commit()


def clear_business_data(conn):
    conn.executescript("""
        DELETE FROM events;
        DELETE FROM clusters;
        DELETE FROM merge_blocks;
        DELETE FROM audit_log;
        DELETE FROM sqlite_sequence WHERE name IN ('events','clusters','merge_blocks','audit_log');
    """)
    conn.commit()


# ---------------- 演示数据（通过关联引擎写入，产生真实的归并依据） ----------------
def seed_demo_events(create_event):
    """create_event: correlation.create_event(conn, payload) -> event row"""
    base = "2026-09-11"
    demo = [
        # —— 簇A：K302 啸叫，跨话筒/功放，同包厢声学问题 ——
        (f"{base}T20:00", "K302", "MIC-302", "howl", "warn", "话筒一靠近音响就啸叫", "小王"),
        (f"{base}T20:08", "K302", "AMP-302", "howl", "warn", "话筒啸叫，功放峰值灯爆红", "小张"),
        (f"{base}T20:20", "K302", "MIC-302", "howl", "warn", "高音段话筒啸叫明显", "小王"),

        # —— 簇B：305/306/307 点歌延迟，汇聚到点歌服务器 ——
        (f"{base}T19:40", "K305", "POD-305", "song_delay", "warn", "点歌后转圈十几秒才开始播放", "小李"),
        (f"{base}T19:44", "K306", "POD-306", "song_delay", "warn", "切歌反应慢，歌单加载卡顿", "小赵"),
        (f"{base}T19:47", "K307", "POD-307", "song_delay", "warn", "点歌延迟严重，搜歌要转半天", "小李"),

        # —— 簇C：K301 电视单台偶发 ——
        (f"{base}T19:05", "K301", "TV-301", "video_break", "warn", "电视画面中断，重新开机后恢复", "小钱"),

        # —— 簇D：K304 点歌屏（误合并素材：显示故障 vs 触摸故障，措辞相近被 R2 合并） ——
        (f"{base}T20:10", "K304", "POD-304", "stuck", "warn", "点歌屏黑屏，重启后恢复正常", "小孙"),
        (f"{base}T20:18", "K304", "POD-304", "stuck", "warn", "点歌屏黑屏，触摸也没反应", "小孙"),

        # —— 独立事件：K304 功放杂音（同包厢但症状不同，不应被并入口簇D） ——
        (f"{base}T20:42", "K304", "AMP-304", "mic_hum", "info", "功放电流杂音，音量越大越明显", "小孙"),

        # —— 簇E：跨区画面中断（502 在5FC、303 在3FA，LCA=核心，疑似媒体服务器） ——
        (f"{base}T21:30", "K502", "TV-502", "video_break", "warn", "电视画面中断黑屏，声音正常", "小周"),
        (f"{base}T21:33", "K303", "TV-303", "video_break", "critical", "画面中断，换HDMI线也没用", "小王"),

        # —— 簇F：5FC 三个包厢离线，疑似区域交换机 ——
        (f"{base}T21:50", "K501", "POD-501", "offline", "critical", "点歌屏离线，重启连不上服务器", "小吴"),
        (f"{base}T21:52", "K502", "POD-502", "offline", "critical", "包厢点歌设备全部离线", "小吴"),
        (f"{base}T21:55", "K503", "POD-503", "offline", "critical", "设备离线，扫码点歌扫不出来", "小郑"),

        # —— 簇G：TV-308 单台间歇性复发（30分钟内3次，单台flapping） ——
        (f"{base}T18:02", "K308", "TV-308", "video_break", "warn", "电视画面中断几秒后自行恢复", "小冯"),
        (f"{base}T18:35", "K308", "TV-308", "video_break", "warn", "电视又断了一下，自己恢复了", "小冯"),
        (f"{base}T19:12", "K308", "TV-308", "video_break", "warn", "画面中断复发，怀疑线材接触不良", "小冯"),
    ]
    results = []
    for ts, room, dev, sym, sev, desc, reporter in sorted(demo, key=lambda x: x[0]):
        results.append(create_event(
            None, ts=ts, room_id=room, device_id=dev, symptom=sym,
            severity=sev, description=desc, reporter=reporter))
    return results
