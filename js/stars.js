/* 黑洞模擬 —— 背景的星空（瀏覽器與 node 共用，不碰畫面）
 *
 * 星星的位置、亮度、顏色是真的：耶魯亮星表第五版，9,096 顆（肉眼看得到的大約到 6.5 等，表裡收到 7.96 等）。
 * 資料在 js/stars_data.js（tools/stars_pack.py 產生）。這裡做三件事：
 *   decode    把資料解成「每顆星朝哪個方向、幾等、什麼顏色」
 *   toWorld   天球怎麼擺進這個模擬的座標：銀河面對到著色器畫的那條銀河（法線 GAL_N），銀河中心朝 GAL_C。
 *             吸積盤躺在 y = 0 的平面上；黑洞跟銀河面的夾角是隨手取的（真的黑洞各有各的朝向）。
 *   buildGrid 著色器每個像素只知道「這道光最後朝哪個方向飛走」，要很快查到那附近有哪些星：
 *             把天球投到立方體的六個面、每面切成 G × G 格，每格記下光暈碰得到這一格的星（最多 K 顆，亮的優先）。
 *             著色器只讀一格；格子只是查表用的，星星本身在球面上的位置不受格子影響。
 *
 * 比星表更暗的星（幾萬顆）沒有資料，著色器另外用亂數補一層很暗的，密度往銀河面集中 —— 那一層不是真的。
 */
(function (root) {
  'use strict';
  var BH = root.BH = root.BH || {};

  // 赤道（J2000）→ 銀河座標的旋轉矩陣（跟 tools/stars_pack.py 同一個；那邊拿星表自己附的銀經銀緯對過，中位數差 0.004°）
  var EQ2GAL = [
    [-0.0548755604, -0.8734370902, -0.4838350155],
    [+0.4941094279, -0.4448296300, +0.7469822445],
    [-0.8676661490, -0.1980763734, +0.4559837762]
  ];
  function norm(v) { var l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  var GAL_N = norm([0.25, 0.9, 0.35]);       // 北銀極在模擬座標裡的方向（著色器畫銀河用的是同一個向量）
  var GAL_C = norm([0.9, -0.25, 0]);         // 銀河中心的方向（跟 GAL_N 垂直）
  var GAL_Y = cross(GAL_N, GAL_C);           // 銀經 90° 的方向

  // 赤經、赤緯（度，J2000）→ 模擬座標裡的單位方向
  function toWorld(raDeg, decDeg) {
    var ra = raDeg * Math.PI / 180, de = decDeg * Math.PI / 180, cd = Math.cos(de);
    var e = [cd * Math.cos(ra), cd * Math.sin(ra), Math.sin(de)], g = [0, 0, 0], i;
    for (i = 0; i < 3; i++) g[i] = EQ2GAL[i][0] * e[0] + EQ2GAL[i][1] * e[1] + EQ2GAL[i][2] * e[2];
    return [g[0] * GAL_C[0] + g[1] * GAL_Y[0] + g[2] * GAL_N[0], g[0] * GAL_C[1] + g[1] * GAL_Y[1] + g[2] * GAL_N[1], g[0] * GAL_C[2] + g[1] * GAL_Y[2] + g[2] * GAL_N[2]];
  }
  function checksum(bytes) { var h = 0x811C9DC5; for (var i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; } return h; }
  // 色指數 B−V → 色溫（K）：Ballesteros 2012 的近似式
  function temperature(bv) { return 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62)); }

  // D ＝ js/stars_data.js。回傳 { n, ra, dec, mag, bv, dir（每顆三個數）, fnv }
  function decode(D) {
    var bin = typeof atob === 'function' ? atob(D.b64) : Buffer.from(D.b64, 'base64').toString('binary');
    var n = D.n, bytes = new Uint8Array(bin.length), i;
    for (i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (bytes.length !== n * 6) throw new Error('星表資料壞了：長度 ' + bytes.length + '，應該是 ' + n * 6);
    var s = { n: n, ra: new Float64Array(n), dec: new Float64Array(n), mag: new Float32Array(n), bv: new Float32Array(n), dir: new Float32Array(3 * n), fnv: checksum(bytes), data: D };
    for (i = 0; i < n; i++) {
      var o = i * 6;
      s.ra[i] = (bytes[o] | (bytes[o + 1] << 8)) / 65536 * 360;
      s.dec[i] = (bytes[o + 2] | (bytes[o + 3] << 8)) / 65535 * 180 - 90;
      s.mag[i] = bytes[o + 4] / 28 - 1.5;
      s.bv[i] = bytes[o + 5] / 100 - 0.4;
      var d = toWorld(s.ra[i], s.dec[i]);
      s.dir[3 * i] = d[0]; s.dir[3 * i + 1] = d[1]; s.dir[3 * i + 2] = d[2];
    }
    return s;
  }

  // 一個方向落在立方體的哪一面、面上的哪裡（u、v ∈ [−1, 1]）。著色器裡是同一個寫法，兩邊要一起改
  function face(d) {
    var ax = Math.abs(d[0]), ay = Math.abs(d[1]), az = Math.abs(d[2]);
    if (ax >= ay && ax >= az) return { f: d[0] > 0 ? 0 : 1, u: d[1] / ax, v: d[2] / ax };
    if (ay >= az) return { f: d[1] > 0 ? 2 : 3, u: d[0] / ay, v: d[2] / ay };
    return { f: d[2] > 0 ? 4 : 5, u: d[0] / az, v: d[1] / az };
  }
  // 著色器畫一顆星的光暈多大（弧度）：越亮越大。跟 shader.js 的 starRadius 同一個式子
  function haloRadius(mag) { return 0.0030 * (1 + 0.5 * Math.max(0, 3 - mag)); }

  /* 分格。回傳 { G, K, width, height, data（Float32Array，RGBA）, dropped（塞不下被丟掉的次數）, maxPer（最擠的一格幾顆）}
   * 每個紋素一顆星：xyz ＝ 方向，w ＝ 色溫 ÷ 250（整數部分，至少 1）＋ (星等 + 2) ÷ 10（小數部分）；w = 0 ＝ 這一格到這裡沒有了。
   * 一顆星會放進它的光暈碰得到的每一格（含隔壁面的格子），所以著色器只要讀自己那一格。
   * pixMax：預期一個像素最大多寬（弧度）—— 光暈至少 1.25 個像素寬，解析度低的時候光暈變大，邊界要多留。 */
  function buildGrid(stars, G, K, pixMax) {
    G = G || 28; K = K || 28;
    var W = 6 * G, H = G * K, data = new Float32Array(W * H * 4), count = new Uint8Array(6 * G * G), dropped = 0, maxPer = 0;
    var AX = [[0, 1, 2, 1], [0, 1, 2, -1], [1, 0, 2, 1], [1, 0, 2, -1], [2, 0, 1, 1], [2, 0, 1, -1]];      // 每一面：主軸、u 軸、v 軸、主軸的正負
    for (var i = 0; i < stars.n; i++) {
      var d = [stars.dir[3 * i], stars.dir[3 * i + 1], stars.dir[3 * i + 2]], mag = stars.mag[i];
      var rad = Math.max(haloRadius(mag), 1.25 * (pixMax || 0.004) * (1 + 0.5 * Math.max(0, 3 - mag))) * 1.8;      // 光暈到 1.8 倍半徑就淡到看不見（著色器在那裡截掉）
      var tIdx = Math.max(1, Math.min(160, Math.round(temperature(stars.bv[i]) / 250))), w = tIdx + Math.max(0, Math.min(0.9999, (mag + 2) / 10));
      for (var f = 0; f < 6; f++) {
        var c = d[AX[f][0]] * AX[f][3];
        if (c < 0.3) continue;                                   // 在另一邊，投不到這一面附近
        var u = d[AX[f][1]] / c, v = d[AX[f][2]] / c, m = rad * (1 + u * u + v * v) * 1.15;     // 光暈在這一面上佔多寬（u、v 的單位；越靠面的角落投影拉得越長）
        if (Math.abs(u) > 1 + m || Math.abs(v) > 1 + m) continue;
        var i0 = Math.max(0, Math.floor((u - m + 1) * 0.5 * G)), i1 = Math.min(G - 1, Math.floor((u + m + 1) * 0.5 * G));
        var j0 = Math.max(0, Math.floor((v - m + 1) * 0.5 * G)), j1 = Math.min(G - 1, Math.floor((v + m + 1) * 0.5 * G));
        for (var cj = j0; cj <= j1; cj++) for (var ci = i0; ci <= i1; ci++) {
          var cell = (f * G + cj) * G + ci, k = count[cell];
          if (k >= K) { dropped++; continue; }                   // 星是照亮度排的 ⇒ 被丟掉的一定是這一格裡最暗的
          var o = ((cj * K + k) * W + f * G + ci) * 4;
          data[o] = d[0]; data[o + 1] = d[1]; data[o + 2] = d[2]; data[o + 3] = w;
          count[cell] = k + 1;
          if (k + 1 > maxPer) maxPer = k + 1;
        }
      }
    }
    return { G: G, K: K, width: W, height: H, data: data, dropped: dropped, maxPer: maxPer, count: count };
  }
  // 讀一格（自我測試用，跟著色器讀法一樣）：方向 d 所在的那一格裡有哪些星 → [{ dir, mag, temp }]
  function lookup(grid, d) {
    var fc = face(d), G = grid.G, K = grid.K, W = grid.width, out = [];
    var ci = Math.max(0, Math.min(G - 1, Math.floor((fc.u * 0.5 + 0.5) * G))), cj = Math.max(0, Math.min(G - 1, Math.floor((fc.v * 0.5 + 0.5) * G)));
    for (var k = 0; k < K; k++) {
      var o = ((cj * K + k) * W + fc.f * G + ci) * 4, w = grid.data[o + 3];
      if (!(w > 0)) break;
      out.push({ dir: [grid.data[o], grid.data[o + 1], grid.data[o + 2]], mag: (w - Math.floor(w)) * 10 - 2, temp: Math.floor(w) * 250 });
    }
    return out;
  }

  var api = { decode: decode, toWorld: toWorld, buildGrid: buildGrid, lookup: lookup, face: face, haloRadius: haloRadius, temperature: temperature, GAL_N: GAL_N, GAL_C: GAL_C, GAL_Y: GAL_Y, EQ2GAL: EQ2GAL };
  BH.Stars = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
