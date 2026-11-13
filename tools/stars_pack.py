# -*- coding: utf-8 -*-
"""把耶魯亮星表（Bright Star Catalogue, 5th Revised Ed.；Hoffleit & Warren 1991，CDS 目錄 V/50）轉成 js/stars_data.js。

    python -I tools/stars_pack.py <catalog.gz 或 catalog> [js/stars_data.js]

星表本身不放進這個專案：到 CDS 或它的鏡像站抓
    https://cdsarc.cds.unistra.fr/ftp/cats/V/50/catalog.gz
    https://vizier.cfa.harvard.edu/ftp/cats/V/50/catalog.gz      （2026-11-13 用的是這一份，573,921 bytes）
欄位位置照同一個目錄下的 ReadMe（Byte-by-byte Description of file: catalog）。

每顆星留四樣，共 6 bytes：
    赤經 J2000    2 bytes   0～65535 ↔ 0°～360°（一格 0.0055°）
    赤緯 J2000    2 bytes   0～65535 ↔ −90°～+90°（一格 0.0027°）
    視星等 V      1 byte    (V + 1.5) × 28      （−1.5～7.6，一格 0.036 等）
    色指數 B−V    1 byte    (B−V + 0.4) × 100   （−0.4～2.15；星表沒給的填 0.60，接近太陽的顏色）
照亮度排（最亮的在最前面）。星表裡 14 筆沒有位置的（已經確認不是恆星、被移除的編號）跳過。

順便驗一件事：用這裡寫的「赤道座標 → 銀河座標」矩陣算出來的銀經銀緯，跟星表自己附的那兩欄比，最大差多少。
js/stars.js 用的是同一個矩陣（把銀河面對到畫面上那條銀河），所以這個數字也是那邊的憑據。
"""
import sys, io, gzip, math, base64, struct, json

# 赤道（J2000）→ 銀河座標的旋轉矩陣（Hipparcos 文件第一卷 1.5.11 式的數值）
EQ2GAL = (
    (-0.0548755604, -0.8734370902, -0.4838350155),
    (+0.4941094279, -0.4448296300, +0.7469822445),
    (-0.8676661490, -0.1980763734, +0.4559837762),
)


def fnv1a(data):
    h = 0x811C9DC5
    for b in data:
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else 'js/stars_data.js'
    raw = gzip.open(src, 'rb').read() if src.endswith('.gz') else io.open(src, 'rb').read()
    stars, skipped, no_bv, gal_max = [], 0, 0, 0.0
    for line in raw.split(b'\n'):
        line = line.decode('latin-1')
        if len(line) < 107:
            continue
        ra_s, de_s, vm_s = line[75:83], line[83:90], line[102:107]
        if not ra_s.strip() or not de_s.strip() or not vm_s.strip():
            skipped += 1
            continue
        ra = (int(ra_s[0:2]) + int(ra_s[2:4]) / 60.0 + float(ra_s[4:8]) / 3600.0) * 15.0
        de = int(de_s[1:3]) + int(de_s[3:5]) / 60.0 + int(de_s[5:7]) / 3600.0
        if de_s[0] == '-':
            de = -de
        vmag = float(vm_s)
        bv_s = line[109:114]
        if bv_s.strip():
            bv = float(bv_s)
        else:
            bv = 0.60
            no_bv += 1
        # 驗矩陣：跟星表附的銀經銀緯比
        cr, sr, cd, sd = math.cos(math.radians(ra)), math.sin(math.radians(ra)), math.cos(math.radians(de)), math.sin(math.radians(de))
        e = (cd * cr, cd * sr, sd)
        g = [sum(EQ2GAL[i][j] * e[j] for j in range(3)) for i in range(3)]
        gl_s, gb_s = line[90:96], line[96:102]
        if gl_s.strip() and gb_s.strip():
            l0, b0 = math.radians(float(gl_s)), math.radians(float(gb_s))
            g0 = (math.cos(b0) * math.cos(l0), math.cos(b0) * math.sin(l0), math.sin(b0))
            ang = math.degrees(math.acos(max(-1.0, min(1.0, sum(g[i] * g0[i] for i in range(3))))))
            gal_max = max(gal_max, ang)
        stars.append((vmag, ra, de, bv, int(line[0:4]), line[4:14].strip()))
    stars.sort(key=lambda s: (s[0], s[4]))
    buf = bytearray()
    for vmag, ra, de, bv, hr, name in stars:
        q_ra = int(round(ra / 360.0 * 65536.0)) & 0xFFFF
        q_de = max(0, min(65535, int(round((de + 90.0) / 180.0 * 65535.0))))
        q_m = max(0, min(255, int(round((vmag + 1.5) * 28.0))))
        q_bv = max(0, min(255, int(round((bv + 0.4) * 100.0))))
        buf += struct.pack('<HHBB', q_ra, q_de, q_m, q_bv)
    data = {
        'source': 'Bright Star Catalogue, 5th Revised Ed. (Hoffleit & Warren 1991), CDS V/50',
        'n': len(stars), 'bytes': 6, 'fnv': fnv1a(bytes(buf)),
        'check': {'skipped': skipped, 'noBV': no_bv, 'galMaxErrDeg': round(gal_max, 4)},
        'brightest': [{'hr': s[4], 'name': s[5], 'v': s[0], 'ra': round(s[1], 4), 'dec': round(s[2], 4)} for s in stars[:5]],
        'b64': base64.b64encode(bytes(buf)).decode('ascii'),
    }
    js = (u"/* 星表：耶魯亮星表第五版（Bright Star Catalogue, 5th Revised Ed.；Hoffleit & Warren 1991），來源 CDS 目錄 V/50。\n"
          u" * 由 tools/stars_pack.py 產生，不要手改。每顆星 6 bytes：赤經、赤緯（J2000）、視星等、色指數 B−V；照亮度排。\n"
          u" * 解碼與「哪顆星在畫面的哪裡」在 js/stars.js。 */\n"
          u"(function (root) {\n  var D = " + json.dumps(data, ensure_ascii=False) + u";\n"
          u"  root.BH = root.BH || {};\n  root.BH.StarData = D;\n"
          u"  if (typeof module !== 'undefined' && module.exports) module.exports = D;\n"
          u"})(typeof window !== 'undefined' ? window : globalThis);\n")
    io.open(out, 'w', encoding='utf-8', newline='\n').write(js)
    print('stars', len(stars), 'skipped(no position)', skipped, 'no B-V', no_bv)
    print('equatorial->galactic matrix vs catalogue GLON/GLAT: max diff %.4f deg' % gal_max)
    print('brightest:', ', '.join('%s V=%.2f' % (s[5] or ('HR%d' % s[4]), s[0]) for s in stars[:8]))
    print('faintest V=%.2f; bytes %d; fnv %d; wrote %s (%d chars)' % (stars[-1][0], len(buf), data['fnv'], out, len(js)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
