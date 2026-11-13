/* 黑洞模擬 —— 飛船模型（雕刻作品的格子）：解碼、顏色、朝向、CPU 版的格子射線
 *
 * 模型來自 js/ship_data.js（tools/ship_pack.py 產生）。著色器把它當一張 3D 貼圖，沿每一小段光線走格子（DDA）找第一個撞到的格；
 * 這裡的 raycast 是同一個走法的 JS 版，用來對拍：node 自我測試拿它對暴力法，顯示卡自我測試拿它對著色器畫出來的剪影。
 *
 * 模型座標（格）：x ＝ 機頭方向、y ＝ 左舷、z ＝ 上；外框 [0, nx] × [0, ny] × [0, nz]，中心放在軌跡上的那一點。
 * 朝向（frame）：機頭朝飛行方向（座標速度）；還沒動起來時朝黑洞。「上」取軌道面的法線 —— 繞圈時像飛機平飛轉彎，
 * 直直掉進去（沒有軌道面）時取世界的 +y。兩邊（這裡與著色器）要一起改。
 */
(function (root) {
  'use strict';

  /* 引擎噴射的樣子（特效，不是模擬；著色器的 shipPlume 照這幾個數畫）：
   *   len  噴射多長 ÷ 引擎半徑；rad  外框的半寬 ÷ 引擎半徑（外面的光暈到這裡已經淡到看不見）；gain  亮度
   * 引擎的位置與半徑來自 ship_data.js 的 engines（tools/ship_pack.py 從格子裡找的）。 */
  var PLUME = { len: 9.5, rad: 2.4, gain: 0.2 };

  function decode(D) {
    var nx = D.dims[0], ny = D.dims[1], nz = D.dims[2], n = nx * ny * nz;
    var bin = typeof atob === 'function' ? atob(D.rle) : Buffer.from(D.rle, 'base64').toString('binary');
    var grid = new Uint8Array(n), i = 0, p = 0, count = 0;
    while (p < bin.length) {
      var v = bin.charCodeAt(p++), L = 0, sh = 0, b;
      do { b = bin.charCodeAt(p++); L += (b & 0x7f) * Math.pow(2, sh); sh += 7; } while (b & 0x80);
      if (i + L > n) throw new Error('飛船資料壞了：長度編碼超出外框');
      if (v) { grid.fill(v, i, i + L); count += L; }
      i += L;
    }
    if (i !== n) throw new Error('飛船資料壞了：解出 ' + i + ' 格，外框是 ' + n + ' 格');
    var emit = new Uint32Array(8);
    for (var k = 0; k < D.emissive.length; k++) emit[D.emissive[k] >> 5] |= (1 << (D.emissive[k] & 31)) >>> 0;
    var m = { dims: [nx, ny, nz], grid: grid, count: count, emit: emit, data: D, engines: (D.engines || []).slice(0, 8), plume: PLUME };
    m.bound = bound(m);
    return m;
  }

  // 每具噴射的外框（模型座標、格）：從噴嘴口往 −x 長 len·r，半寬 rad·r
  function plumeBox(e, pl) {
    var L = pl.len * e.r, R = pl.rad * e.r;
    return { min: [e.x - L, e.y - R, e.z - R], max: [e.x, e.y + R, e.z + R] };
  }

  /* 包圍球（以外框中心為球心）半徑 ÷ 半個船長：要包住船身外框與每一具噴射的外框。
   * 著色器先用它粗篩光線；包得不夠 ⇒ 噴射的尾巴會被切掉。 */
  function bound(m) {
    var c = [m.dims[0] / 2, m.dims[1] / 2, m.dims[2] / 2], best = 0;
    var boxes = [{ min: [0, 0, 0], max: m.dims }].concat(m.engines.map(function (e) { return plumeBox(e, m.plume); }));
    boxes.forEach(function (b) {
      for (var i = 0; i < 8; i++) {
        var p = [(i & 1) ? b.max[0] : b.min[0], (i & 2) ? b.max[1] : b.min[1], (i & 4) ? b.max[2] : b.min[2]];
        best = Math.max(best, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]));
      }
    });
    return best / c[0];
  }

  // 校驗碼：每個非空格的 (一維位置 4 byte LE, 色號) 餵 FNV-1a 32（tools/ship_pack.py 用 Python 另外算一次）
  function checksum(m) {
    var h = 0x811c9dc5 >>> 0, g = m.grid;
    function eat(b) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
    for (var i = 0; i < g.length; i++) {
      if (!g[i]) continue;
      eat(i & 255); eat((i >>> 8) & 255); eat((i >>> 16) & 255); eat((i >>> 24) & 255); eat(g[i]);
    }
    return h >>> 0;
  }

  // RGB332 調色盤（跟 Senate 雕刻同一張：r 3 bit、g 3 bit、b 2 bit）
  function rgb(i) { return [((i >> 5) & 7) / 7, ((i >> 2) & 7) / 7, (i & 3) / 3]; }

  function norm(v) { var l = Math.hypot(v[0], v[1], v[2]); return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  /* 朝向：pos、vel（座標速度）、hole（黑洞位置）→ 三個單位向量（世界座標）
   *   fwd ＝ 機頭（模型 +x）、side ＝ 左舷（模型 +y）、up ＝ 上（模型 +z），右手系 fwd × side = up。 */
  function frame(pos, vel, hole) {
    var rel = [pos[0] - hole[0], pos[1] - hole[1], pos[2] - hole[2]];
    var fwd = Math.hypot(vel[0], vel[1], vel[2]) > 1e-4 ? norm(vel) : norm([-rel[0], -rel[1], -rel[2]]);
    if (!(Math.abs(fwd[0]) + Math.abs(fwd[1]) + Math.abs(fwd[2]) > 0)) fwd = [1, 0, 0];
    var up = cross(rel, vel);
    if (Math.hypot(up[0], up[1], up[2]) < 1e-6 * (Math.hypot(rel[0], rel[1], rel[2]) * Math.hypot(vel[0], vel[1], vel[2]) + 1e-12)) up = [0, 1, 0];
    up = norm(up);
    var d = dot(up, fwd);
    up = [up[0] - d * fwd[0], up[1] - d * fwd[1], up[2] - d * fwd[2]];
    if (Math.hypot(up[0], up[1], up[2]) < 1e-3) up = Math.abs(fwd[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    d = dot(up, fwd);
    up = norm([up[0] - d * fwd[0], up[1] - d * fwd[1], up[2] - d * fwd[2]]);
    return { fwd: fwd, side: cross(up, fwd), up: up };
  }

  /* 格子射線（DDA）：模型座標裡從 o 沿 d 走，s ∈ [0, sMax]；回傳第一個非空格 {s, cell, axis, color}，沒撞到 ⇒ null。
   * axis ＝ 進到這一格時穿過的是哪個軸的面（0/1/2），法線 ＝ −sign(d[axis])。著色器裡是同一個走法。 */
  function raycast(m, o, d, sMax, maxIter) {
    var nx = m.dims[0], ny = m.dims[1], nz = m.dims[2], g = m.grid;
    var dims = [nx, ny, nz], sN = 0, sF = sMax, axis = -1, k;
    var ds = [Math.abs(d[0]) < 1e-12 ? 1e-12 : d[0], Math.abs(d[1]) < 1e-12 ? 1e-12 : d[1], Math.abs(d[2]) < 1e-12 ? 1e-12 : d[2]];
    for (k = 0; k < 3; k++) {
      var tA = (0 - o[k]) / ds[k], tB = (dims[k] - o[k]) / ds[k];
      var lo = Math.min(tA, tB), hi = Math.max(tA, tB);
      if (lo > sN) { sN = lo; axis = k; }
      if (hi < sF) sF = hi;
    }
    if (sN > sF) return null;
    var s = sN, p = [o[0] + d[0] * s, o[1] + d[1] * s, o[2] + d[2] * s];
    var c = [0, 0, 0], st = [0, 0, 0], tMax = [0, 0, 0], tDel = [0, 0, 0];
    for (k = 0; k < 3; k++) {
      c[k] = Math.min(dims[k] - 1, Math.max(0, Math.floor(p[k])));
      st[k] = ds[k] > 0 ? 1 : -1;
      tMax[k] = ((c[k] + (st[k] > 0 ? 1 : 0)) - o[k]) / ds[k];
      tDel[k] = Math.abs(1 / ds[k]);
    }
    if (axis < 0) axis = 0;
    var lim = maxIter || (nx + ny + nz + 3);
    for (var it = 0; it < lim; it++) {
      var v = g[c[0] + nx * (c[1] + ny * c[2])];
      if (v) return { s: s, cell: [c[0], c[1], c[2]], axis: axis, color: v };
      var a = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
      s = tMax[a];
      if (s > sF) return null;
      c[a] += st[a]; tMax[a] += tDel[a]; axis = a;
      if (c[a] < 0 || c[a] >= dims[a]) return null;
    }
    return null;
  }

  // 暴力法（只給測試用）：每個非空格都跟射線求交，取最近的那個
  function bruteforce(m, o, d, sMax) {
    var nx = m.dims[0], ny = m.dims[1], nz = m.dims[2], g = m.grid, best = null, k;
    var ds = [Math.abs(d[0]) < 1e-12 ? 1e-12 : d[0], Math.abs(d[1]) < 1e-12 ? 1e-12 : d[1], Math.abs(d[2]) < 1e-12 ? 1e-12 : d[2]];
    var inv = [1 / ds[0], 1 / ds[1], 1 / ds[2]];
    for (var z = 0; z < nz; z++) for (var y = 0; y < ny; y++) for (var x = 0; x < nx; x++) {
      var v = g[x + nx * (y + ny * z)];
      if (!v) continue;
      var lo = 0, hi = sMax, c = [x, y, z];
      for (k = 0; k < 3; k++) {
        var tA = (c[k] - o[k]) * inv[k], tB = (c[k] + 1 - o[k]) * inv[k];
        lo = Math.max(lo, Math.min(tA, tB)); hi = Math.min(hi, Math.max(tA, tB));
      }
      if (lo <= hi && (!best || lo < best.s)) best = { s: lo, cell: c, color: v };
    }
    return best;
  }

  var api = { decode: decode, checksum: checksum, rgb: rgb, frame: frame, raycast: raycast, bruteforce: bruteforce, plumeBox: plumeBox, PLUME: PLUME };
  root.BH = root.BH || {};
  root.BH.Ship = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
