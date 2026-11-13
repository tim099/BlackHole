/* 黑洞模擬 —— 太空戰鬥模式的運動學工具（不碰畫面、不碰網頁元件；瀏覽器與 node 共用）
 *
 * 這裡的東西全部走 physics.js 那一套度規，沒有另外一份「遊戲物理」：
 *   推進    有質量的粒子沒開引擎時走測地線（跟模擬模式的物體同一條）；開引擎 ＝ 加一個固有加速度 a：
 *           4-速度在「跟自己垂直、朝推力方向」的單位向量 e 上轉一個快度 a·dτ：u′ = cosh(a dτ) u + sinh(a dτ) e。
 *           平直空間裡一直往同一個方向推 ⇒ v = tanh(aτ)，永遠到不了光速；懸停要的推力就是 rs / (2r²√(1 − rs/r))。
 *   發射    從船自己的靜止系裡、照機頭的方向射出去：光（k = u + e）走零測地線；有質量的東西（u′ = γ(u + v e)）走測地線。
 *           兩種都會被黑洞彎，慢的彎得多。
 *   射擊解  目標在動、自己在動、路是彎的 ⇒ 真的把東西沿測地線追出去，對瞄準方向做高斯–牛頓法。
 *   看到的  攝影機標架、標記投影都有算光行差。
 *
 * 一場戰鬥（船、武器、損傷、敵機、波次）在 js/world.js。
 */
(function (root) {
  'use strict';
  var node = typeof module !== 'undefined' && !!module.exports;
  var BH = root.BH = root.BH || {};
  var P = node ? require('./physics.js') : BH.Physics;

  // ── 小工具 ──────────────────────────────────────────
  function len(v) { return Math.hypot(v[0], v[1], v[2]); }
  function norm(v) { var l = len(v); return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0]; }
  function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  // 繞單位軸 k 轉 ang（右手）
  function rotate(v, k, ang) {
    var c = Math.cos(ang), s = Math.sin(ang), kv = cross(k, v), kd = dot3(k, v) * (1 - c);
    return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
  }
  function rng(seed) {       // mulberry32：同一個種子同一場
    var a = seed >>> 0;
    return function () { a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  var _d = new Float64Array(8);
  function velocity4(holes, s) { P.rhs(holes, s, _d); return [_d[0], _d[1], _d[2], _d[3]]; }
  // 座標方向 d（3 維）→ 跟 4-速度 u 垂直的單位空間向量（u 那個觀察者的靜止系裡，d 指的方向）
  function orthU(g, u, d) {
    var v = [d[0], d[1], d[2], 0], c = P.dot(g, v, u);
    var o = [v[0] + c * u[0], v[1] + c * u[1], v[2] + c * u[2], v[3] + c * u[3]];
    var n = Math.sqrt(Math.abs(P.dot(g, o, o)));
    if (!(n > 1e-12)) return null;
    return [o[0] / n, o[1] / n, o[2] / n, o[3] / n];
  }
  function radius(holes, s) { var c = holes[0].pos; return Math.hypot(s[0] - c[0], s[1] - c[1], s[2] - c[2]); }
  // 船自己的靜止系裡，機頭（座標方向 nose）指的方向（4 維單位向量）
  function restDir(holes, s, nose) { return orthU(P.metricCov(holes, s), velocity4(holes, s), nose); }

  // ── 推進 ────────────────────────────────────────────
  // 朝座標方向 dir 給一個快度 dv（＝ 固有加速度 × 固有時）。動量四個分量一起轉，所以 g(u,u) = −1 不會跑掉
  function kick(holes, s, dir, dv) {
    var g = P.metricCov(holes, s), u = velocity4(holes, s), e = orthU(g, u, dir);
    if (!e) return;
    var pl = P.lower(g, e), ch = Math.cosh(dv), sh = Math.sinh(dv);
    s[4] = ch * s[4] + sh * pl[0]; s[5] = ch * s[5] + sh * pl[1]; s[6] = ch * s[6] + sh * pl[2]; s[7] = ch * s[7] + sh * pl[3];
  }
  /* 戰場外圍的「空間扭曲」（遊戲設定，不是這顆黑洞的重力）：離黑洞超過 wall.R 之後多一個往回帶的加速度 wall.k × (r − R)，
   * 越遠越強，所以直直往外飛最後會掉頭回來。只作用在船與飛彈上；光不受影響（畫面照舊）。 */
  function wallKick(holes, s, h, wall) {
    var c = holes[0].pos, x = s[0] - c[0], y = s[1] - c[1], z = s[2] - c[2], r = Math.hypot(x, y, z);
    if (r > wall.R) kick(holes, s, [-x / r, -y / r, -z / r], wall.k * (r - wall.R) * h);
  }
  // 一小步：半個推力、一步測地線、半個推力
  function substep(holes, s, h, dir, a, wall) {
    if (a > 0) kick(holes, s, dir, 0.5 * a * h);
    if (wall) wallKick(holes, s, 0.5 * h, wall);
    P.rk4(holes, s, h);
    if (wall) wallKick(holes, s, 0.5 * h, wall);
    if (a > 0) kick(holes, s, dir, 0.5 * a * h);
  }
  // 走 dTau 的固有時。回傳實際走了多少（到奇異點附近會提早停）。hMax：一小步最多多長（預設 0.02）
  function advanceTau(holes, s, dTau, dir, a, wall, hMax) {
    var rem = dTau, guard = 0, cap = hMax || 0.02, frac = cap > 0.02 ? 0.03 : 0.01;
    while (rem > 1e-12 && guard++ < 20000) {
      P.rhs(holes, s, _d);
      var h = Math.min(rem, cap, P.stepSize(holes, s, _d, frac));
      substep(holes, s, h, dir, a, wall);
      rem -= h;
      var near = P.nearest(holes, s);
      if (near.k >= 0 && near.ratio < 0.02) break;
    }
    return dTau - rem;
  }
  // 走到座標時間 tTarget。回傳過了多少固有時
  function advanceTo(holes, s, tTarget, dir, a, wall) {
    var tau = 0, guard = 0;
    while (guard++ < 20000) {
      P.rhs(holes, s, _d);
      var left = (tTarget - s[3]) / Math.max(_d[3], 1e-9);
      if (!(left > 1e-9)) break;
      var h = Math.min(left, 0.02, P.stepSize(holes, s, _d, 0.01));
      substep(holes, s, h, dir, a, wall);
      tau += h;
      var near = P.nearest(holes, s);
      if (near.k >= 0 && near.ratio < 0.02) break;
    }
    return tau;
  }
  // 不再動引擎的話接下來會走的路（有算外圍的空間扭曲）：每隔 every 的固有時記一點，給雷達畫
  function predict(holes, s0, span, wall, every) {
    var s = Float64Array.from(s0), o = { X: [s[0]], Y: [s[1]], Z: [s[2]], T: [s[3]], n: 1, fate: 'timeout' }, dt = every || 1.5;
    for (var t = 0; t < span; t += dt) {
      var done = advanceTau(holes, s, dt, null, 0, wall, 0.1);
      o.X.push(s[0]); o.Y.push(s[1]); o.Z.push(s[2]); o.T.push(s[3]); o.n++;
      if (done < dt - 1e-9) { o.fate = 'singularity'; break; }
    }
    return o;
  }

  /* 當地懸停的人量到的速度，以及「要修成圓軌道該往哪推」。
   *   o.rTarget  想待在哪個半徑（沒給 ＝ 現在的半徑）
   *   o.prefer   沒有切向速度時往哪一邊繞（座標方向）
   * 回傳 dir（推力的座標方向）、mag（還差多少速度，單位 c）、v（現在的速度）、vr（徑向，往外為正）、vt（切向）、vc（當地圓軌道速度）。
   * 視界內沒有懸停的人 ⇒ inside = true、dir 朝外（沒有用，只是不讓呼叫的人拿到空的）。 */
  function steer(holes, s, o) {
    o = o || {};
    var h = holes[0], x = [s[0] - h.pos[0], s[1] - h.pos[1], s[2] - h.pos[2]], r = len(x), rhat = r > 1e-9 ? norm(x) : [1, 0, 0];
    var g = P.metricCov(holes, s), u0 = P.staticU(g), u = velocity4(holes, s), i;
    if (!u0) return { dir: rhat, mag: 1, v: null, vr: 0, vt: 0, vc: NaN, inside: true };
    var gam = -P.dot(g, u, u0), w = [], er = orthU(g, u0, rhat);
    for (i = 0; i < 4; i++) w.push(u[i] / gam - u0[i]);
    var wr = P.dot(g, w, er), wt = [], tp = null;
    for (i = 0; i < 4; i++) wt.push(w[i] - wr * er[i]);
    var vt = Math.sqrt(Math.max(0, P.dot(g, wt, wt)));
    function tangent(d) {
      var e = orthU(g, u0, d); if (!e) return null;
      var c = P.dot(g, e, er), t = [e[0] - c * er[0], e[1] - c * er[1], e[2] - c * er[2], e[3] - c * er[3]];
      var m = Math.sqrt(Math.max(0, P.dot(g, t, t)));
      return m > 0.05 ? [t[0] / m, t[1] / m, t[2] / m, t[3] / m] : null;
    }
    if (vt > 1e-3) tp = [wt[0] / vt, wt[1] / vt, wt[2] / vt, wt[3] / vt];
    if (!tp && o.prefer) tp = tangent(o.prefer);
    if (!tp) tp = tangent(cross([0, 1, 0], rhat)) || tangent([1, 0, 0]) || tangent([0, 0, 1]);
    var rT = o.rTarget != null ? o.rTarget : r;
    var vc = P.vCirc(Math.max(r, 1.6 * h.rs), h.rs);
    if (!(vc > 0)) vc = 0;                                  // 沒有黑洞 ⇒ 沒有圓軌道，目標就是停下來
    var vrWant = clamp((rT - r) * 0.03, -0.15, 0.15), D = [];
    for (i = 0; i < 4; i++) D.push(vc * tp[i] + vrWant * er[i] - w[i]);
    var mag = Math.sqrt(Math.max(0, P.dot(g, D, D)));
    return { dir: norm([D[0], D[1], D[2]]), mag: mag, v: Math.sqrt(Math.max(0, P.dot(g, w, w))), vr: wr, vt: vt, vc: vc, inside: false, rate: 1 / u[3] };
  }

  // ── 發射 ────────────────────────────────────────────
  /* 從船（狀態 s）在船自己的靜止系裡朝機頭方向 dir 射出一個東西。
   *   v ≥ 1 ⇒ 光子：k = u + e
   *   v < 1 ⇒ 有質量、相對船的速度是 v：u′ = γ(u + v e)
   * pos：出膛的位置（世界座標；沒給 ＝ 船心）。換了位置度規不一樣，所以把 p_t 重新接回去。 */
  function launch(holes, s, dir, v, pos) {
    var g = P.metricCov(holes, s), u = velocity4(holes, s), e = orthU(g, u, dir);
    if (!e) return null;
    var light = !(v < 1), q = light ? [u[0] + e[0], u[1] + e[1], u[2] + e[2], u[3] + e[3]] : P.boost(u, e, v), p = P.lower(g, q);
    var x = pos || [s[0], s[1], s[2]];
    var st = new Float64Array([x[0], x[1], x[2], s[3], p[0], p[1], p[2], p[3]]);
    if (pos) P.normalizeMomentum(holes, st, light ? 0 : -1);
    return st;
  }
  /* 想讓光子（在當地懸停的人看來）朝方向 n 飛，機頭要指哪裡？
   * 船在動 ⇒ 有光行差：機頭指的方向跟光實際飛的方向不一樣。回傳 { nose（座標方向）, e（船的靜止系裡的單位向量，4 維）}。
   * 視界內沒有懸停的人 ⇒ null。 */
  function noseFor(holes, s, n) {
    var ps = P.launch(holes, [s[0], s[1], s[2]], n, 1, 'light');
    if (!ps) return null;
    var k = P.raise(P.metricInv(holes, s), [ps[4], ps[5], ps[6], ps[7]]);
    var g = P.metricCov(holes, s), u = velocity4(holes, s), om = -P.dot(g, k, u), e = [], i;
    for (i = 0; i < 4; i++) e.push(k[i] / om - u[i]);
    var c = e[3] / u[3];
    return { nose: norm([e[0] - c * u[0], e[1] - c * u[1], e[2] - c * u[2]]), e: e };
  }
  // 把一個狀態（位置、時刻、動量）當成測地線往後推 span 這麼久（預測「它不再開引擎的話會到哪」）
  function coast(holes, st, span) {
    var s = new Float64Array([st.x, st.y, st.z, st.t, st.px, st.py, st.pz, st.pt]);
    return P.trace(holes, s, { tSpan: span, rMax: 400, frac: 0.012, maxSteps: 40000, tau0: st.tau || 0 });
  }
  /* 射擊解：從 s（射手的狀態）射一個東西，要碰到沿著 target（一條軌跡）走的目標，機頭該指哪裡。
   *   o.speed  ≥ 1 ＝ 光；< 1 ＝ 有質量、相對射手的速度（慢的東西飛得久、被黑洞彎得多、要抓的提前量也大）
   *   o.range  追多久（座標時間）
   *   o.tol    最近距離小於這個才算有解
   * 先用直線估當起點；再真的沿測地線追出去，看「同一個時刻離目標最近時差了多少」，
   * 對機頭方向的兩個角度做高斯–牛頓法（差分求斜率），把那個差距壓到零。黑洞旁邊路彎得很兇，
   * 「差多少就把瞄準點挪多少」那種修法不收斂（試過：差 5.4 rs 修四次還差 3.7）。
   * 回傳 { nose（機頭的座標方向）, e（船的靜止系裡的方向）, miss, tHit, tr, ok, iters }。
   * o.flat = true ⇒ 只做直線估（反向對照用）。 */
  function solveShot(holes, s, target, o) {
    o = o || {};
    var x0 = [s[0], s[1], s[2]], t0 = s[3], v = o.speed != null ? o.speed : 1, light = !(v < 1), range = o.range || 26, tol = o.tol || 0.1;
    function tgt(t) { var q = P.sampleAt(target, t); return [q.x, q.y, q.z]; }
    var aim = tgt(t0), k, i, dir;
    if (light) {
      for (k = 0; k < 4; k++) aim = tgt(t0 + len(sub(aim, x0)));
      dir = norm(sub(aim, x0));
      var nf = noseFor(holes, s, dir);
      if (nf) dir = nf.nose;                                   // 視界內沒有這個修正，交給下面的迭代
    } else {
      // 慢的東西：自己的速度會疊上去，飛的方向跟機頭不一樣 ⇒ 邊估邊修
      dir = norm(sub(aim, x0));
      for (k = 0; k < 6; k++) {
        var st0 = launch(holes, s, dir, v);
        if (!st0) return null;
        P.rhs(holes, st0, _d);
        var w = [_d[0] / _d[3], _d[1] / _d[3], _d[2] / _d[3]], sp = Math.max(len(w), 0.05);
        aim = tgt(t0 + len(sub(aim, x0)) / sp);
        var want = norm(sub(aim, x0)), wn = norm(w);
        dir = norm([dir[0] + want[0] - wn[0], dir[1] + want[1] - wn[1], dir[2] + want[2] - wn[2]]);
      }
    }
    var n0 = dir, ea = norm(cross(n0, Math.abs(n0[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), eb = cross(n0, ea);
    function shoot(th) {
      var n = norm([n0[0] + th[0] * ea[0] + th[1] * eb[0], n0[1] + th[0] * ea[1] + th[1] * eb[1], n0[2] + th[0] * ea[2] + th[1] * eb[2]]);
      var ps = launch(holes, s, n, v);
      if (!ps) return null;
      var tr = P.trace(holes, ps, { tSpan: range, rMax: 400, frac: 0.012, maxSteps: 6000, rEnd: 0.9 });      // 掉到視界裡面就不用再追了
      // 同一個時刻它與目標的距離，找最小的那一段，再在那一段裡用相對直線運動解最近點
      // ⚠ 這裡的迴圈變數要自己宣告（j），不能用外層的 i：外層「縮小步子再試」的迴圈也在數 i，
      //   共用的話這裡會把它改回去 —— 最近點剛好落在軌跡起點時，外層那個迴圈永遠跑不完（2026-11-13 實際卡死過）
      var dMin = Infinity, iMin = 0, j;
      for (j = 0; j < tr.n; j++) {
        var q = tgt(tr.T[j]), d = Math.hypot(tr.X[j] - q[0], tr.Y[j] - q[1], tr.Z[j] - q[2]);
        if (d < dMin) { dMin = d; iMin = j; }
      }
      var res = { d: dMin, t: tr.T[iMin] };
      for (j = Math.max(0, iMin - 1); j < Math.min(tr.n - 1, iMin + 1); j++) {
        var c = closest([tr.X[j], tr.Y[j], tr.Z[j]], [tr.X[j + 1], tr.Y[j + 1], tr.Z[j + 1]], tgt(tr.T[j]), tgt(tr.T[j + 1]));
        if (c.d < res.d) res = { d: c.d, t: tr.T[j] + c.w * (tr.T[j + 1] - tr.T[j]) };
      }
      var ph = P.sampleAt(tr, res.t), tq = tgt(res.t);
      return { n: n, miss: res.d, m: [ph.x - tq[0], ph.y - tq[1], ph.z - tq[2]], tHit: res.t, tr: tr };
    }
    var th = [0, 0], cur = shoot(th), iters = 1;
    if (!cur) return null;
    for (k = 0; !o.flat && k < (o.iters || 6) && cur.miss > 0.1 * tol; k++) {
      var h = 2e-3, f1 = shoot([th[0] + h, th[1]]), f2 = shoot([th[0], th[1] + h]);
      if (!f1 || !f2) break;
      var J1 = [(f1.m[0] - cur.m[0]) / h, (f1.m[1] - cur.m[1]) / h, (f1.m[2] - cur.m[2]) / h];
      var J2 = [(f2.m[0] - cur.m[0]) / h, (f2.m[1] - cur.m[1]) / h, (f2.m[2] - cur.m[2]) / h];
      var a11 = dot3(J1, J1), a12 = dot3(J1, J2), a22 = dot3(J2, J2), b1 = -dot3(J1, cur.m), b2 = -dot3(J2, cur.m);
      var det = a11 * a22 - a12 * a12;
      if (!(Math.abs(det) > 1e-12)) break;
      var dl = [(b1 * a22 - b2 * a12) / det, (a11 * b2 - a12 * b1) / det], dn = Math.hypot(dl[0], dl[1]);
      if (dn > 0.35) { dl[0] *= 0.35 / dn; dl[1] *= 0.35 / dn; }      // 一次最多挪 20° 左右
      var next = null, sc = 1;
      for (i = 0; i < 4; i++, sc *= 0.5) {                           // 沒變好就縮小步子再試
        var c2 = shoot([th[0] + dl[0] * sc, th[1] + dl[1] * sc]);
        if (c2 && c2.miss < cur.miss) { next = c2; th = [th[0] + dl[0] * sc, th[1] + dl[1] * sc]; break; }
      }
      iters++;
      if (!next) break;
      cur = next;
    }
    return { nose: cur.n, e: restDir(holes, s, cur.n), miss: cur.miss, tHit: cur.tHit, tr: cur.tr, ok: cur.miss <= tol, iters: iters };
  }
  // 兩個點各自等速直線（a0→a1、b0→b1，同一段時間）：最近的距離 d 與發生在這一段的哪裡 w ∈ [0, 1]
  function closest(a0, a1, b0, b1) {
    var d0 = [a0[0] - b0[0], a0[1] - b0[1], a0[2] - b0[2]];
    var dv = [a1[0] - a0[0] - (b1[0] - b0[0]), a1[1] - a0[1] - (b1[1] - b0[1]), a1[2] - a0[2] - (b1[2] - b0[2])];
    var vv = dot3(dv, dv), w = vv > 1e-18 ? clamp(-dot3(d0, dv) / vv, 0, 1) : 0;
    return { d: Math.hypot(d0[0] + dv[0] * w, d0[1] + dv[1] * w, d0[2] + dv[2] * w), w: w };
  }
  // 線段 a→b 離點 c 最近多遠（視線有沒有被黑洞擋住）
  function segNear(a, b, c) {
    var ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    var w = clamp(dot3(ac, ab) / Math.max(dot3(ab, ab), 1e-18), 0, 1);
    return Math.hypot(a[0] + ab[0] * w - c[0], a[1] + ab[1] * w - c[1], a[2] + ab[2] * w - c[2]);
  }

  // ── 攝影機 ──────────────────────────────────────────
  /* 跟著船走的攝影機：位置 pos、空間動量跟船一樣（p 是船的共變動量 [px, py, pz]），朝 fwd、上方 up。
   * 回傳的東西跟 BH.Camera.frame() 同一種，另外多給還沒降指標的標架 fr 與度規 g（投影標記用）。 */
  function cameraFrame(holes, pos, p, fwd, up) {
    var s = new Float64Array([pos[0], pos[1], pos[2], 0, p[0], p[1], p[2], 0]);
    P.normalizeMomentum(holes, s, -1);
    var g = P.metricCov(holes, s), u = velocity4(holes, s), fr = P.frame(g, u, fwd, up);
    var near = P.nearest(holes, s), us = P.staticU(g), v = null;
    if (us) { var gam = -P.dot(g, u, us); v = Math.sqrt(Math.max(0, 1 - 1 / (gam * gam))); }
    var c = holes[0].pos;
    return {
      pos: pos.slice(), fwd: fwd.slice(), g: g, fr: fr, u: u,
      P: [P.lower(g, fr.e0), P.lower(g, fr.e1), P.lower(g, fr.e2), P.lower(g, fr.e3)],
      r: Math.hypot(pos[0] - c[0], pos[1] - c[1], pos[2] - c[2]), ratio: near.k < 0 ? Infinity : near.ratio,
      insideHorizon: near.k >= 0 && near.ratio < 1, nearHorizon: near.k >= 0 && near.ratio < 1.012, v: v, rate: 1 / u[3]
    };
  }
  /* 從世界上某一點 src 直線飛到攝影機的光，會出現在畫面的哪裡。
   * 回傳 [x, y, z]：畫面座標 x／z、y／z（乘上 1/tan(視角/2) 就是 −1～1），z ≤ 0 ＝ 在背後。
   * 有算光行差（攝影機在動），沒有算光被黑洞彎 —— 視線貼近黑洞時標記會跟畫面上的像對不上，呼叫的人要自己判斷。
   * 視界內 ⇒ null。 */
  function project(holes, cf, src) {
    var n = norm([cf.pos[0] - src[0], cf.pos[1] - src[1], cf.pos[2] - src[2]]);
    var ps = P.launch(holes, cf.pos, n, 1, 'light');
    if (!ps) return null;
    var k = [ps[4], ps[5], ps[6], ps[7]];
    function comp(e) { return k[0] * e[0] + k[1] * e[1] + k[2] * e[2] + k[3] * e[3]; }
    var om = -comp(cf.fr.e0);
    return [-comp(cf.fr.e1) / om, -comp(cf.fr.e2) / om, -comp(cf.fr.e3) / om];
  }
  // 船的靜止系裡的方向 e（4 維）在攝影機標架裡的三個分量：把準星移到那裡，射出去的東西就朝 e
  function projectDir(cf, e) { return [P.dot(cf.g, e, cf.fr.e1), P.dot(cf.g, e, cf.fr.e2), P.dot(cf.g, e, cf.fr.e3)]; }

  // ── 歷史（每個會自己動的東西走過的路；欄位跟 P.trace 的回傳一樣，再加朝向）────
  var HK = ['T', 'X', 'Y', 'Z', 'UX', 'UY', 'UZ', 'UT', 'PX', 'PY', 'PZ', 'PT', 'TAU', 'FX', 'FY', 'FZ', 'TH', 'GX', 'GY', 'GZ', 'FL'];
  function histNew() {
    var h = { n: 0, fate: 'live', crossT: null, crossTau: null, crossHole: -1, rMin: Infinity, e: 1 };
    for (var i = 0; i < HK.length; i++) h[HK[i]] = [];
    return h;
  }
  // sh：{ s, tau, fwd, up, thr, flash }
  function histPush(holes, h, sh) {
    var s = sh.s, u = velocity4(holes, s);
    var v = [s[3], s[0], s[1], s[2], u[0], u[1], u[2], u[3], s[4], s[5], s[6], s[7], sh.tau, sh.fwd[0], sh.fwd[1], sh.fwd[2], sh.thr, sh.up[0], sh.up[1], sh.up[2], sh.flash];
    var at = (h.n >= 2 && s[3] - h.T[h.n - 2] < 0.05) ? h.n - 1 : h.n;      // 太密就蓋掉最後一格，不一直長
    for (var i = 0; i < HK.length; i++) h[HK[i]][at] = v[i];
    h.n = at + 1;
  }
  function histTrim(h, tMin) {
    if (h.n < 16 || h.T[8] >= tMin) return;
    var i0 = 0;
    while (i0 < h.n - 2 && h.T[i0 + 1] < tMin) i0++;
    for (var i = 0; i < HK.length; i++) h[HK[i]] = h[HK[i]].slice(i0);
    h.n = h.T.length;
  }
  // 朝向：機頭朝飛行方向、上方 ＝ 軌道面法線（跟 js/ship.js 的 frame 同一個定義）
  function frameFromVel(pos, vel, hole) {
    var rel = [pos[0] - hole[0], pos[1] - hole[1], pos[2] - hole[2]];
    var fwd = len(vel) > 1e-6 ? norm(vel) : norm([-rel[0], -rel[1], -rel[2]]);
    if (len(fwd) < 0.5) fwd = [1, 0, 0];
    var up = cross(rel, vel);
    if (len(up) < 1e-9) up = [0, 1, 0];
    up = norm(up);
    var d = dot3(up, fwd);
    up = [up[0] - d * fwd[0], up[1] - d * fwd[1], up[2] - d * fwd[2]];
    if (len(up) < 1e-3) { up = Math.abs(fwd[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]; d = dot3(up, fwd); up = [up[0] - d * fwd[0], up[1] - d * fwd[1], up[2] - d * fwd[2]]; }
    return { fwd: fwd, up: norm(up) };
  }
  function histFromTrace(tr, hole) {
    var h = histNew(), i;
    for (i = 0; i < 13; i++) h[HK[i]] = tr[HK[i]].slice();
    h.n = tr.n;
    for (i = 0; i < tr.n; i++) {
      var f = frameFromVel([tr.X[i], tr.Y[i], tr.Z[i]], [tr.UX[i], tr.UY[i], tr.UZ[i]], hole);
      h.FX.push(f.fwd[0]); h.FY.push(f.fwd[1]); h.FZ.push(f.fwd[2]); h.TH.push(0);
      h.GX.push(f.up[0]); h.GY.push(f.up[1]); h.GZ.push(f.up[2]); h.FL.push(0);
    }
    return h;
  }
  /* 赤道面附近的一條圓軌道：半徑 r、方位角 phi、傾角 incl、方向 sense（+1 順著吸積盤、−1 逆著）。
   * 從 tBirth 開始算到 tNow，回傳現在的狀態與這一段走過的路（給「光行時間之前」的樣子用）。 */
  function orbit(holes, r, phi, incl, sense, tBirth, tNow) {
    var c = holes[0].pos, cp = Math.cos(phi), sp = Math.sin(phi), ci = Math.cos(incl), si = Math.sin(incl);
    var ea = [cp, 0, sp], eb = [ci * sp, si, -ci * cp];
    var s = P.launchLocal(holes, [c[0] + r * cp, c[1], c[2] + r * sp], [-ea[0], -ea[1], -ea[2]], eb, sense * Math.PI / 2, P.vCirc(r, holes[0].rs), 'ball');
    if (!s) return null;
    s[3] = tBirth;
    var tr = P.trace(holes, s, { tSpan: Math.max(tNow - tBirth, 0.5), rMax: 400, frac: 0.012, maxSteps: 80000 });
    var n = tr.n - 1;
    return { s: new Float64Array([tr.X[n], tr.Y[n], tr.Z[n], tr.T[n], tr.PX[n], tr.PY[n], tr.PZ[n], tr.PT[n]]), tau: tr.TAU[n], tr: tr };
  }

  var G = {
    kick: kick, advanceTau: advanceTau, advanceTo: advanceTo, predict: predict, steer: steer, launch: launch, noseFor: noseFor, coast: coast, solveShot: solveShot,
    closest: closest, segNear: segNear, cameraFrame: cameraFrame, project: project, projectDir: projectDir, restDir: restDir,
    orbit: orbit, frameFromVel: frameFromVel, histNew: histNew, histPush: histPush, histTrim: histTrim, histFromTrace: histFromTrace,
    velocity4: velocity4, orthU: orthU, rotate: rotate, norm: norm, cross: cross, dot3: dot3, sub: sub, len: len, clamp: clamp, radius: radius, rng: rng
  };
  BH.Game = G;
  if (node) module.exports = G;
})(typeof window !== 'undefined' ? window : globalThis);
