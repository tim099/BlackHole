"""把雕刻作品的格子清單封成 js/ship_data.js（飛船模型）

    senate cmd sculpture --arg op=export --arg work=claude-afterglow --arg format=list --arg links=none --arg out=<清單.txt>
    python -I tools/ship_pack.py <清單.txt> js/ship_data.js --name 餘暉號 --work claude-afterglow --mpv 0.1

清單每行 x,y,z,color（雕刻座標：x 機頭方向、y 寬、z 上；color 是 RGB332 調色盤 index，0 ＝ 空）。
做的事：
  1. 裁到有格子的外框；
  2. 照 x 最快、再 y、再 z 的順序排成一維（跟 WebGL 的 3D 貼圖上傳順序一樣）；
  3. 長度編碼：一串 (值, 連續幾格) —— 值 1 byte、長度用 varint；整串再 base64；
  4. 另外算一個校驗碼（FNV-1a 32，餵每個非空格的 (一維位置, 色號)），JS 解碼之後自己算一次對拍；
  5. 從格子裡找引擎（噴射特效從哪裡噴）：發光的引擎盤（色號 191 核心、83 外圈）連成一塊（6 連通）的就是一具，
     盤要是平的（同一個 x）；中心 ＝ 盤的重心，半徑 ＝ 跟盤同面積的圓，噴嘴口 ＝ 盤後面、離軸不到「半徑 ＋ 2.5 格」的
     船身格裡 x 最小的那一格（噴射從那個平面往 −x 噴）。都用裁過之後的座標（格心 ＝ 整數 ＋ 0.5）。
只用標準函式庫。
"""
import argparse
import base64
import hashlib
import json
import math
import sys
from collections import deque

EMISSIVE = [191, 83, 224, 28, 254, 248]   # 引擎核心、引擎外圈、左右航行燈、尾燈、舷窗（雕刻作品 design/gen_ship.py 那張表）
ENGINE_GLOW = {191, 83}                    # 引擎盤的顏色


def find_engines(cellmap):
    """cellmap：{(x,y,z): color}（裁過的座標）→ 引擎清單 [{x 噴嘴口, y, z, r, disc 盤在哪個 x, cells 盤幾格}]"""
    glow = {p for p, c in cellmap.items() if c in ENGINE_GLOW}
    seen, comps = set(), []
    for p in sorted(glow):
        if p in seen:
            continue
        comp, q = [], deque([p])
        seen.add(p)
        while q:
            a = q.popleft()
            comp.append(a)
            for d in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)):
                b = (a[0] + d[0], a[1] + d[1], a[2] + d[2])
                if b in glow and b not in seen:
                    seen.add(b)
                    q.append(b)
        comps.append(comp)
    engines = []
    for comp in comps:
        xs = {p[0] for p in comp}
        if len(xs) != 1:
            sys.exit("引擎盤不是平的（橫跨 x = %s）：找引擎的規則只認平的盤" % sorted(xs))
        xd = xs.pop()
        cy = sum(p[1] + 0.5 for p in comp) / len(comp)
        cz = sum(p[2] + 0.5 for p in comp) / len(comp)
        r = math.sqrt(len(comp) / math.pi)
        behind = [p[0] for p, c in cellmap.items()
                  if p[0] < xd and c not in ENGINE_GLOW and math.hypot(p[1] + 0.5 - cy, p[2] + 0.5 - cz) <= r + 2.5]
        engines.append({"x": min(behind) if behind else xd, "y": round(cy, 6), "z": round(cz, 6), "r": round(r, 4),
                        "disc": xd, "cells": len(comp)})
    engines.sort(key=lambda e: (e["x"], e["y"], e["z"]))
    return engines


def fnv1a(pairs):
    h = 0x811C9DC5
    for idx, v in pairs:
        for b in (idx & 0xFF, (idx >> 8) & 0xFF, (idx >> 16) & 0xFF, (idx >> 24) & 0xFF, v):
            h ^= b
            h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--name", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--mpv", type=float, required=True, help="每格幾公尺")
    a = ap.parse_args()

    raw = open(a.src, "rb").read()
    cells = []
    for line in raw.decode("utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        x, y, z, c = (int(v) for v in line.split(","))
        if not (1 <= c <= 255):
            sys.exit("色號超出 1..255：%s" % line)
        cells.append((x, y, z, c))
    if not cells:
        sys.exit("清單是空的")
    x0 = min(c[0] for c in cells); y0 = min(c[1] for c in cells); z0 = min(c[2] for c in cells)
    x1 = max(c[0] for c in cells); y1 = max(c[1] for c in cells); z1 = max(c[2] for c in cells)
    nx, ny, nz = x1 - x0 + 1, y1 - y0 + 1, z1 - z0 + 1
    grid = bytearray(nx * ny * nz)
    seen = set()
    for (x, y, z, c) in cells:
        i = (x - x0) + nx * ((y - y0) + ny * (z - z0))
        if i in seen:
            sys.exit("同一格出現兩次：%d,%d,%d" % (x, y, z))
        seen.add(i)
        grid[i] = c

    # 長度編碼
    out = bytearray()
    i, n, runs = 0, len(grid), 0
    while i < n:
        v = grid[i]; j = i + 1
        while j < n and grid[j] == v:
            j += 1
        L = j - i
        out.append(v)
        while True:
            b = L & 0x7F; L >>= 7
            out.append(b | (0x80 if L else 0))
            if not L:
                break
        runs += 1
        i = j

    pairs = sorted(((x - x0) + nx * ((y - y0) + ny * (z - z0)), c) for (x, y, z, c) in cells)
    engines = find_engines({(x - x0, y - y0, z - z0): c for (x, y, z, c) in cells})
    meta = {
        "name": a.name,
        "work": a.work,
        "listSha256": hashlib.sha256(raw).hexdigest(),
        "metersPerVoxel": a.mpv,
        "dims": [nx, ny, nz],
        "origin": [x0, y0, z0],
        "count": len(cells),
        "fnv": fnv1a(pairs),
        "runs": runs,
        "emissive": EMISSIVE,
        "engines": engines,
    }
    b64 = base64.b64encode(bytes(out)).decode("ascii")
    with open(a.dst, "w", encoding="utf-8", newline="\n") as fo:
        fo.write("/* 由 tools/ship_pack.py 產生 —— 不要手改（改雕刻作品，再重新匯出、重新封）。\n")
        fo.write(" * 來源：雕刻作品 %s（%s），每格 %.3g m，外框 %d×%d×%d 格，非空 %d 格。\n" % (a.work, a.name, a.mpv, nx, ny, nz, len(cells)))
        fo.write(" * 格式：rle ＝ base64 的一串 (色號 1 byte, 連續幾格 varint)，照 x 最快、再 y、再 z；fnv ＝ 每個非空格 (一維位置 4 byte LE, 色號) 的 FNV-1a 32。\n")
        fo.write(" * engines ＝ 從格子找到的引擎（噴嘴口 x、中心 y z、半徑 r，裁過的座標、單位格；噴射往 −x）。 */\n")
        fo.write("(function (root) {\n  'use strict';\n  var D = " + json.dumps(meta, ensure_ascii=False) + ";\n")
        fo.write("  D.rle = '" + b64 + "';\n")
        fo.write("  root.BH = root.BH || {};\n  root.BH.ShipData = D;\n")
        fo.write("  if (typeof module !== 'undefined' && module.exports) module.exports = D;\n")
        fo.write("})(typeof window !== 'undefined' ? window : globalThis);\n")
    print(json.dumps(dict(meta, rleBytes=len(out), jsBytes=len(b64)), ensure_ascii=False))


if __name__ == "__main__":
    main()
