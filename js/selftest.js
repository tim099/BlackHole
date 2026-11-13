/* 黑洞模擬 —— 物理核心的自我測試：每一項都印「量到的／解析值／誤差／容許」，不是只印通過。
 *   node js/selftest.js          在終端機跑
 *   index.html?selftest=1        在瀏覽器跑（另外加上用顯示卡算的幾項，寫在 app.js）
 */
(function (root) {
  'use strict';
  var node = typeof module !== 'undefined' && !!module.exports;
  var P = node ? require('./physics.js') : root.BH.Physics;

  function row(name, got, want, tol, how, note) {
    var err = (how === 'abs') ? Math.abs(got - want) : Math.abs(got - want) / Math.abs(want);
    return { name: name, got: got, want: want, err: err, tol: tol, how: how || 'rel', pass: err <= tol, note: note || '' };
  }

  // 在赤道面（y = 0）從 (x0, 0, z0) 往 +x 射一道光，回傳軌跡與它的撞擊參數 b = |L| / E
  function shootLight(holes, x0, z0, rMax) {
    var s = P.launch(holes, [x0, 0, z0], [1, 0, 0], 1, 'light');
    var Ly = s[2] * s[4] - s[0] * s[6];
    var b = Math.abs(Ly) / (-s[7]);
    var tr = P.trace(holes, s, { rMax: rMax, frac: 0.01, maxSteps: 200000 });
    return { tr: tr, b: b };
  }

  // 軌跡上第一次 r 降到 rTarget 時的某個量（線性內插）
  function atRadius(tr, rTarget, arr, rising) {
    for (var i = 1; i < tr.n; i++) {
      var r0 = Math.hypot(tr.X[i - 1], tr.Y[i - 1], tr.Z[i - 1]);
      var r1 = Math.hypot(tr.X[i], tr.Y[i], tr.Z[i]);
      var hit = rising ? (r0 < rTarget && r1 >= rTarget) : (r0 > rTarget && r1 <= rTarget);
      if (hit) { var w = (rTarget - r0) / (r1 - r0); return arr[i - 1] + w * (arr[i] - arr[i - 1]); }
    }
    return NaN;
  }

  function run() {
    var out = [];
    var H1 = [P.makeHole({ rs: 1 })];
    var i, tr, s;

    // 1. 弱場偏折角
    (function () {
      var r = shootLight(H1, -3000, 50, 3200);
      var n = r.tr.n - 1;
      var ang = Math.atan2(-r.tr.UZ[n], r.tr.UX[n]);
      var q = 1 / r.b;
      var want = 2 * q + (15 * Math.PI / 16) * q * q;
      out.push(row('弱場偏折角（b ≈ 50 rs，弧度）', ang, want, 5e-3, 'rel', '解析值 = 2rs/b + (15π/16)(rs/b)²；b = ' + r.b.toFixed(4)));
    })();

    // 2. 臨界撞擊參數：二分找「剛好被抓住」的 b
    (function () {
      var lo = 2.0, hi = 3.2, bLo = 0, bHi = 0;
      for (i = 0; i < 44; i++) {
        var mid = 0.5 * (lo + hi);
        var r = shootLight(H1, -400, mid, 450);
        if (r.tr.fate === 'singularity') { lo = mid; bLo = r.b; } else { hi = mid; bHi = r.b; }
      }
      out.push(row('臨界撞擊參數 b_c / rs', 0.5 * (bLo + bHi), P.B_CRIT, 1e-4, 'rel', '解析值 = 3√3/2'));
    })();

    // 3. 光子球：r = 1.5 rs 切向射出的光繞一圈還在 1.5 rs
    (function () {
      s = P.launch(H1, [1.5, 0, 0], [0, 0, 1], 1, 'light');
      var period = 2 * Math.PI * Math.sqrt(2 * 1.5 * 1.5 * 1.5);
      tr = P.trace(H1, s, { tSpan: period, frac: 0.004, maxSteps: 200000 });
      var dev = 0;
      for (i = 0; i < tr.n; i++) dev = Math.max(dev, Math.abs(Math.hypot(tr.X[i], tr.Y[i], tr.Z[i]) - 1.5));
      out.push(row('光子球：繞一圈後 |r − 1.5 rs| 的最大值', dev, 0, 1e-4, 'abs', '座標週期 ' + period.toFixed(3) + ' rs/c'));
    })();

    // 4. 從靜止徑向落下的固有時（r0 = 10 → 0.02 rs）
    (function () {
      s = P.launch(H1, [10, 0, 0], [-1, 0, 0], 0, 'ball');
      tr = P.trace(H1, s, { rEnd: 0.01, frac: 0.005, maxSteps: 400000 });
      var got = atRadius(tr, 0.02, tr.TAU);
      var eta = Math.acos(2 * 0.02 / 10 - 1);
      var want = 0.5 * 10 * Math.sqrt(10) * (eta + Math.sin(eta));
      out.push(row('靜止落下的固有時 τ（10 → 0.02 rs）', got, want, 1e-4, 'rel', '擺線解；到 r = 0 是 (π/2) r0 √(r0/rs) = ' + (Math.PI / 2 * 10 * Math.sqrt(10)).toFixed(4)));
    })();

    // 5. 圓軌道 r = 6 rs：一個週期後半徑沒變、剛好轉一圈
    (function () {
      var r0 = 6;
      s = P.launch(H1, [r0, 0, 0], [0, 0, 1], P.vCirc(r0, 1), 'ball');
      var period = 2 * Math.PI * Math.sqrt(2 * r0 * r0 * r0);
      tr = P.trace(H1, s, { tSpan: period, frac: 0.005, maxSteps: 400000 });
      var dev = 0;
      for (i = 0; i < tr.n; i++) dev = Math.max(dev, Math.abs(Math.hypot(tr.X[i], tr.Y[i], tr.Z[i]) - r0));
      var n = tr.n - 1;
      var phi = Math.atan2(tr.Z[n], tr.X[n]);
      out.push(row('圓軌道 r = 6 rs：一圈內 |r − 6| 的最大值', dev, 0, 1e-5, 'abs', '速度 v = ' + P.vCirc(r0, 1).toFixed(6) + ' c'));
      out.push(row('圓軌道 r = 6 rs：過一個座標週期後的角度（弧度）', phi, 0, 1e-4, 'abs', '週期 = 2π√(2r³/rs) = ' + period.toFixed(4)));
    })();

    // 6. ISCO 的能量
    (function () {
      s = P.launch(H1, [3, 0, 0], [0, 0, 1], P.vCirc(3, 1), 'ball');
      out.push(row('ISCO（r = 3 rs）圓軌道的能量 E/m', -s[7], Math.sqrt(8 / 9), 1e-9, 'rel', '解析值 = √(8/9)'));
    })();

    // 7. 哈密頓量守恆（一條會掉進去的軌道）
    (function () {
      s = P.launch(H1, [8, 0, 0], [0, 0, 1], 0.2, 'ball');
      tr = P.trace(H1, s, { frac: 0.01, tSpan: 2000, maxSteps: 400000 });
      var st = new Float64Array(8), devOut = 0, devIn = 0;
      for (i = 0; i < tr.n; i++) {
        st[0] = tr.X[i]; st[1] = tr.Y[i]; st[2] = tr.Z[i]; st[3] = tr.T[i];
        st[4] = tr.PX[i]; st[5] = tr.PY[i]; st[6] = tr.PZ[i]; st[7] = tr.PT[i];
        var dH = Math.abs(P.hamiltonian(H1, st) + 0.5);
        if (Math.hypot(tr.X[i], tr.Y[i], tr.Z[i]) > 1) devOut = Math.max(devOut, dH); else devIn = Math.max(devIn, dH);
      }
      out.push(row('H 守恆：|H + ½| 的最大值，視界外（r = 8 切向 0.2c 掉進去）', devOut, 0, 1e-7, 'abs', '結局 ' + tr.fate + '，' + tr.n + ' 步'));
      out.push(row('H 守恆：|H + ½| 的最大值，視界內一路到 0.02 rs', devIn, 0, 1e-3, 'abs', '越靠近奇異點動量越大，誤差跟著放大；步長減半誤差約除以 16（四階）'));
    })();

    // 8. 雨滴（從無限遠靜止落下，E/m = 1）
    (function () {
      s = P.launch(H1, [10, 0, 0], [-1, 0, 0], P.vEsc(10, 1), 'ball');
      tr = P.trace(H1, s, { rEnd: 0.01, frac: 0.005, maxSteps: 400000 });
      out.push(row('雨滴：E/m', -s[7], 1, 1e-9, 'rel', '在 r = 10 rs 以當地逃逸速度向內'));
      var got = atRadius(tr, 0.02, tr.TAU);
      var want = (2 / 3) * (Math.pow(10, 1.5) - Math.pow(0.02, 1.5));
      out.push(row('雨滴的固有時 τ（10 → 0.02 rs）', got, want, 1e-4, 'rel', '解析值 = (2/3)(r0^1.5 − r^1.5)/√rs'));
      var tWant = (2 / 3) * (Math.pow(10, 1.5) - 1) - 2 * (1 - Math.sqrt(10)) + 2 * Math.log(2 / (Math.sqrt(10) + 1));
      out.push(row('雨滴穿過視界的座標時間 t（有限）', tr.crossT, tWant, 1e-4, 'rel', '這套座標在視界上不發散'));
    })();

    // 9. 標架正交：靠近視界的靜止觀察者、視界內的落體
    (function () {
      function frameErr(g, fr) {
        var e = [fr.e0, fr.e1, fr.e2, fr.e3], eta = [-1, 1, 1, 1], dev = 0;
        for (var a = 0; a < 4; a++) for (var b = 0; b < 4; b++) {
          dev = Math.max(dev, Math.abs(P.dot(g, e[a], e[b]) - (a === b ? eta[a] : 0)));
        }
        return dev;
      }
      var x = [1.05 * 0.6, 1.05 * 0.0, 1.05 * 0.8];
      var g = P.metricCov(H1, x);
      var fr = P.frame(g, P.staticU(g), [-0.6, 0.1, -0.8], [0, 1, 0]);
      out.push(row('標架正交誤差：r = 1.05 rs 的靜止觀察者', frameErr(g, fr), 0, 1e-9, 'abs'));
      s = P.launch(H1, [10, 0, 0], [-1, 0, 0], P.vEsc(10, 1), 'ball');
      tr = P.trace(H1, s, { rEnd: 0.01, frac: 0.01 });
      for (i = 0; i < tr.n; i++) if (Math.hypot(tr.X[i], tr.Y[i], tr.Z[i]) < 0.5) break;
      var xi = [tr.X[i], tr.Y[i], tr.Z[i]];
      g = P.metricCov(H1, xi);
      var u = [tr.UX[i], tr.UY[i], tr.UZ[i], tr.UT[i]];
      fr = P.frame(g, u, [-1, 0.2, 0.1], [0, 1, 0]);
      out.push(row('標架正交誤差：視界內 r ≈ 0.5 rs 的落體', frameErr(g, fr), 0, 1e-9, 'abs', 'g(u,u) = ' + P.dot(g, u, u).toFixed(9)));
    })();

    // 10. 向外的光離開視界附近要花多久（「凍結」的來源）
    (function () {
      s = P.launch(H1, [1.01, 0, 0], [1, 0, 0], 1, 'light');
      tr = P.trace(H1, s, { rMax: 12, frac: 0.002, maxSteps: 400000 });
      var got = atRadius(tr, 10, tr.T, true);
      out.push(row('向外的光從 1.01 rs 到 10 rs 的座標時間', got, P.outgoingDelay(1.01, 10, 1), 1e-3, 'rel', '解析值 = Δr + 2rs ln((r2−rs)/(r1−rs))；從 1.0001 rs 出發要 ' + P.outgoingDelay(1.0001, 10, 1).toFixed(2)));
    })();

    // 11. p_t 重新歸一
    (function () {
      s = P.launch(H1, [3, 0, 0], [0, 0, 1], 0.4, 'ball');
      var want = s[7];
      s[7] = 123;
      P.normalizeMomentum(H1, s, -1);
      out.push(row('由空間動量解回 p_t', s[7], want, 1e-9, 'rel'));
    })();

    // 13. 視界內還剩多少時間（跟 NASA 2024、Hamilton 的影片比對用；見 README「跟文獻比對」）
    (function () {
      // 徑向雨滴：通過視界 → 0.02 rs
      s = P.launch(H1, [10, 0, 0], [-1, 0, 0], P.vEsc(10, 1), 'ball');
      tr = P.trace(H1, s, { rEnd: 0.01, frac: 0.005, maxSteps: 400000 });
      out.push(row('視界內剩下的固有時：徑向雨滴（1 → 0.02 rs）', atRadius(tr, 0.02, tr.TAU) - tr.crossTau, (2 / 3) * (1 - Math.pow(0.02, 1.5)), 1e-4, 'rel',
        '解析值 (2/3) rs/c；人馬座 A*（430 萬倍太陽質量，rs/c = 42.35 秒）是 ' + ((2 / 3) * 42.35).toFixed(1) + ' 秒'));
      // 帶角動量的拋物線墜落（E/m = 1，L 略小於臨界值 2 rs c）：找出讓 L = 1.98 的發射角
      var v = P.vEsc(10, 1), lo = 0, hi = Math.PI / 2, L = 0, a = 0;
      for (i = 0; i < 50; i++) {
        a = 0.5 * (lo + hi);
        s = P.launch(H1, [10, 0, 0], [-Math.cos(a), 0, Math.sin(a)], v, 'ball');
        L = Math.abs(s[2] * s[4] - s[0] * s[6]);
        if (L < 1.98) lo = a; else hi = a;
      }
      tr = P.trace(H1, s, { rEnd: 0.01, frac: 0.004, maxSteps: 400000 });
      var E = -s[7], N = 200000, sum = 0;
      function fI(r) { return 1 / Math.sqrt(E * E - (1 - 1 / r) * (1 + L * L / (r * r))); }
      for (i = 0; i <= N; i++) { var rr = 0.02 + (1 - 0.02) * i / N; sum += fI(rr) * (i === 0 || i === N ? 1 : (i % 2 ? 4 : 2)); }
      var want = sum * (1 - 0.02) / N / 3;
      out.push(row('視界內剩下的固有時：帶角動量的拋物線墜落（E/m = 1、L = 1.98 rs c）', atRadius(tr, 0.02, tr.TAU) - tr.crossTau, want, 1e-4, 'rel',
        '解析值是徑向方程式的數值積分。NASA 2024 的影片 12.8 秒（430 萬倍）＝ 0.30 rs/c，Hamilton 16 秒（500 萬倍）＝ 0.33 rs/c，都是繞進去的軌道'));
    })();

    // 14. 雨滴觀察者通過視界時回頭看正後方：天空的光頻率剩一半（解析值 1/(1 + √(rs/r))）
    (function () {
      s = P.launch(H1, [10, 0, 0], [-1, 0, 0], P.vEsc(10, 1), 'ball');
      tr = P.trace(H1, s, { rEnd: 0.01, frac: 0.003, maxSteps: 400000 });
      function shiftBehind(st) {
        var x = [st.x, st.y, st.z], g = P.metricCov(H1, x), u = [st.ux, st.uy, st.uz, st.ut];
        var rr = Math.hypot(st.x, st.y, st.z);
        var fr = P.frame(g, u, [st.x / rr, st.y / rr, st.z / rr], [0, 1, 0]);   // 「前」＝背對黑洞
        var p0 = P.lower(g, fr.e0), p3 = P.lower(g, fr.e3);
        return 1 / (-p0[3] + p3[3]);          // 著色器裡同一條式子：p = −P0 + d·P，g = 1 / p_t
      }
      var st = P.sampleAt(tr, tr.crossT);
      out.push(row('雨滴觀察者在視界回頭看：正後方天空的頻率變成幾倍', shiftBehind(st), 0.5, 1e-4, 'rel', '紅移一半；黑洞不會在這一刻把天空「關掉」'));
      for (i = 1; i < tr.n; i++) if (Math.hypot(tr.X[i], tr.Y[i], tr.Z[i]) <= 0.05) break;
      st = P.sampleAt(tr, tr.T[i]);
      var r05 = Math.hypot(st.x, st.y, st.z);
      out.push(row('雨滴觀察者在 0.05 rs 回頭看：正後方天空的頻率變成幾倍', shiftBehind(st), 1 / (1 + Math.sqrt(1 / r05)), 1e-4, 'rel',
        '越往裡面正後方越紅越暗；同一刻影子邊緣那一圈的頻率是 ' + (P.B_CRIT / r05).toFixed(0) + ' 倍左右（藍移）'));
    })();

    // 12. 反向對照：把黑洞拿掉 ⇒ 光走直線、瞄準中心也不會被抓住
    (function () {
      var H0 = [P.makeHole({ rs: 0 })];
      var r = shootLight(H0, -300, 5, 400);
      var n = r.tr.n - 1;
      out.push(row('反向對照（沒有黑洞）：b = 5 的偏折角', Math.atan2(-r.tr.UZ[n], r.tr.UX[n]), 0, 1e-12, 'abs'));
      r = shootLight(H0, -300, 0.5, 400);
      out.push(row('反向對照（沒有黑洞）：b = 0.5 的光有沒有被抓住（0 = 沒有）', r.tr.fate === 'singularity' ? 1 : 0, 0, 0, 'abs', '結局 ' + r.tr.fate));
      r = shootLight(H1, -300, 0.5, 400);
      out.push(row('對照組（有黑洞）：b = 0.5 的光有沒有被抓住（1 = 有）', r.tr.fate === 'singularity' ? 1 : 0, 1, 0, 'abs', '結局 ' + r.tr.fate));
    })();

    // 13. 飛船模型（雕刻作品的格子）：解碼對得上 Python 那一側、格子射線對得上暴力法
    (function () {
      var Ship = node ? require('./ship.js') : root.BH.Ship, D = node ? require('./ship_data.js') : root.BH.ShipData;
      if (!Ship || !D) { out.push(row('飛船模型載入了沒有（1 = 有）', 0, 1, 0, 'abs', '少了 js/ship.js 或 js/ship_data.js')); return; }
      var m = Ship.decode(D);
      out.push(row('飛船：解碼出來的非空格數', m.count, D.count, 0, 'abs', D.work + '（' + D.name + '），外框 ' + D.dims.join('×') + '，每格 ' + D.metersPerVoxel + ' m'));
      out.push(row('飛船：校驗碼（JS 解碼後算的 − Python 封檔時算的）', Ship.checksum(m), D.fnv, 0, 'abs', 'FNV-1a 32；兩邊各自從格子算'));
      // 隨機射線：從外框外面隨便一點，瞄外框裡隨便一點；DDA 跟暴力法要撞到同一格（或都沒撞到）
      var seed = 12345;
      function rnd() { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; }
      var N = 160, agree = 0, hits = 0, worst = 0, nx = D.dims[0], ny = D.dims[1], nz = D.dims[2], k;
      for (k = 0; k < N; k++) {
        var tgt = [nx * (0.15 + 0.7 * rnd()), ny * (0.15 + 0.7 * rnd()), nz * (0.15 + 0.7 * rnd())];
        var th = Math.acos(2 * rnd() - 1), ph = 2 * Math.PI * rnd(), R = 1.2 * Math.hypot(nx, ny, nz);
        var o = [nx / 2 + R * Math.sin(th) * Math.cos(ph), ny / 2 + R * Math.sin(th) * Math.sin(ph), nz / 2 + R * Math.cos(th)];
        var d = [tgt[0] - o[0], tgt[1] - o[1], tgt[2] - o[2]];
        var a = Ship.raycast(m, o, d, 1.5), b = Ship.bruteforce(m, o, d, 1.5);
        if (!a && !b) { agree++; continue; }
        if (a && b) {
          hits++;
          var ds = Math.abs(a.s - b.s) * Math.hypot(d[0], d[1], d[2]);   // 換成「格」
          worst = Math.max(worst, ds);
          if (ds < 1e-6) agree++;
        }
      }
      out.push(row('飛船：格子射線（DDA）跟暴力法撞到同一個深度的比例（' + N + ' 條隨機射線，其中 ' + hits + ' 條有撞到）', agree / N, 1, 0, 'abs',
        '撞到的那一點最多差 ' + worst.toExponential(1) + ' 格（剛好碰在兩格的稜線上時兩邊可能挑不同格，所以比深度不比格號）'));
      // 反向對照：格子全部清空，同一個走法一條都不該撞到；只留一格，瞄著它要撞到、偏一格要撞不到
      var empty = { dims: m.dims, grid: new Uint8Array(m.grid.length) }, any = 0;
      for (k = 0; k < 40; k++) {
        var o2 = [-50 + 300 * rnd(), -50 + 200 * rnd(), -20 + 80 * rnd()], d2 = [nx / 2 - o2[0], ny / 2 - o2[1], nz / 2 - o2[2]];
        if (Ship.raycast(empty, o2, d2, 2)) any++;
      }
      out.push(row('飛船・反向對照：格子全部清空之後，40 條射線撞到東西的條數', any, 0, 0, 'abs'));
      var one = { dims: m.dims, grid: new Uint8Array(m.grid.length) }, cx = 37, cy = 51, cz = 12;
      one.grid[cx + nx * (cy + ny * cz)] = 7;
      var hitOne = Ship.raycast(one, [-20, cy + 0.5, cz + 0.5], [cx + 20.5, 0, 0], 2), missOne = Ship.raycast(one, [-20, cy + 1.5, cz + 0.5], [cx + 20.5, 0, 0], 2);
      out.push(row('飛船・反向對照：只留一格 (37,51,12)，正對它射撞到的 x 格號 ＋ 偏一格射撞到的條數', (hitOne ? hitOne.cell[0] : -1) + (missOne ? 1 : 0), cx, 0, 'abs',
        '撞到的面 ' + (hitOne ? '軸 ' + hitOne.axis : '—') + '（應該是 0：從 −x 那一面進去）'));
      // 引擎（噴射從哪裡噴）：tools/ship_pack.py 從格子找的。船左右對稱 ⇒ 每一具都要有鏡像的另一具（y ↔ ny − y，中間那具對到自己）
      var E = m.engines, unpaired = 0, shallow = 0, worstPair = 0;
      E.forEach(function (e) {
        var best = Infinity;
        E.forEach(function (f) { if (f.x === e.x && f.z === e.z) best = Math.min(best, Math.abs(f.y - (ny - e.y)) + Math.abs(f.r - e.r)); });
        worstPair = Math.max(worstPair, best);
        if (!(best < 1e-6)) unpaired++;
        if (!(e.disc > e.x)) shallow++;
        var c = D.dims, g = m.grid, at = Math.floor(e.disc) + c[0] * (Math.floor(e.y) + c[1] * Math.floor(e.z));
        if (D.emissive.indexOf(g[at]) < 0) shallow++;          // 盤的中心那一格要真的是發光的引擎格
      });
      out.push(row('飛船：找到的引擎具數', E.length, 5, 0, 'abs', E.map(function (e) { return '(' + e.x + ', ' + e.y + ', ' + e.z + ') r=' + e.r; }).join('　')));
      out.push(row('飛船：引擎沒有鏡像對手的具數 ＋ 噴嘴口不在發光盤後面（或盤心不是發光格）的具數', unpaired + shallow, 0, 0, 'abs',
        '鏡像最多差 ' + worstPair.toExponential(1) + ' 格（船是照中線 y = ' + (ny / 2) + ' 左右對稱雕的）'));
      var gridBound = Math.hypot(nx, ny, nz) / nx;
      var cover = 1;
      E.forEach(function (e) {
        var bx = Ship.plumeBox(e, m.plume);
        for (var k2 = 0; k2 < 8; k2++) {
          var p2 = [(k2 & 1) ? bx.max[0] : bx.min[0], (k2 & 2) ? bx.max[1] : bx.min[1], (k2 & 4) ? bx.max[2] : bx.min[2]];
          if (Math.hypot(p2[0] - nx / 2, p2[1] - ny / 2, p2[2] - nz / 2) > m.bound * nx / 2 + 1e-9) cover = 0;
        }
      });
      out.push(row('飛船：包圍球包得住每一具噴射的外框（1 = 是）', cover, 1, 0, 'abs',
        '包圍球 ÷ 半船長 = ' + m.bound.toFixed(3) + '（只包船身的話是 ' + gridBound.toFixed(3) + '；著色器先用它粗篩，包不住 ⇒ 噴射尾巴被切掉）'));
    })();

    // ── 太空戰鬥模式（js/game.js 運動學、js/world.js 一場戰鬥）──
    (function () {
      var G = node ? require('./game.js') : root.BH.Game, W = node ? require('./world.js') : root.BH.World;
      var Ship = node ? require('./ship.js') : root.BH.Ship, D = node ? require('./ship_data.js') : root.BH.ShipData;
      if (!G || !W || !Ship || !D) { out.push(row('戰鬥核心載入了沒有（1 = 有）', 0, 1, 0, 'abs', '少了 js/game.js、js/world.js 或飛船模型')); return; }
      var M = W.setModel(Ship.decode(D));
      var H0 = [P.makeHole({ rs: 0 })], d8 = new Float64Array(8), st, a, q, k;
      function speedX(holes, s2) { P.rhs(holes, s2, d8); return d8[0] / d8[3]; }
      function part(key) { for (var j = 0; j < M.parts.length; j++) if (M.parts[j].key === key) return j; return -1; }
      function missOf(tr2, tgTr) {      // 一條軌跡跟目標（另一條軌跡）在同一個時刻最近多遠
        var best = Infinity;
        for (var j = 0; j < tr2.n - 1; j++) {
          var qa = P.sampleAt(tgTr, tr2.T[j]), qb = P.sampleAt(tgTr, tr2.T[j + 1]);
          best = Math.min(best, G.closest([tr2.X[j], tr2.Y[j], tr2.Z[j]], [tr2.X[j + 1], tr2.Y[j + 1], tr2.Z[j + 1]], [qa.x, qa.y, qa.z], [qb.x, qb.y, qb.z]).d);
        }
        return best;
      }

      // 推進：平直空間一直往同一個方向推 ⇒ v = tanh(aτ)（雙曲線運動），不是 aτ
      st = P.launch(H0, [5, 0, 0], [1, 0, 0], 0, 'ball');
      G.advanceTau(H0, st, 30, [1, 0, 0], 0.03);
      out.push(row('戰鬥・推進：平直空間固有加速度 0.03、推 30 的固有時之後的速度', speedX(H0, st), Math.tanh(0.9), 1e-6, 'rel', '解析值 tanh(aτ) = tanh(0.9)；牛頓的 aτ 是 0.9'));
      st = P.launch(H0, [5, 0, 0], [1, 0, 0], 0, 'ball');
      G.advanceTau(H0, st, 20, [1, 0, 0], 0.2);
      out.push(row('戰鬥・推進：推到 aτ = 4 還是到不了光速（1 − v）', 1 - speedX(H0, st), 1 - Math.tanh(4), 1e-6, 'rel', '牛頓的話早就 4 倍光速了'));

      // 懸停：往外推的固有加速度剛好是 rs / (2r²√(1 − rs/r)) ⇒ 半徑不動
      var r0 = 6, aHover = 1 / (2 * r0 * r0 * Math.sqrt(1 - 1 / r0));
      st = P.launch(H1, [r0, 0, 0], [1, 0, 0], 0, 'ball');
      G.advanceTau(H1, st, 20, [1, 0, 0], aHover);
      var rHover = Math.hypot(st[0], st[1], st[2]);
      st = P.launch(H1, [r0, 0, 0], [1, 0, 0], 0, 'ball');
      G.advanceTau(H1, st, 20, [1, 0, 0], 0);
      var rFree = Math.hypot(st[0], st[1], st[2]);
      out.push(row('戰鬥・推進：在 6 rs 用懸停該有的推力往外推 20 的固有時，半徑變了多少', rHover - r0, 0, 2e-5, 'abs',
        '推力 ' + aHover.toFixed(6) + '（解析值 rs / (2r²√(1 − rs/r))）。反向對照：同一段時間不推，掉到 ' + rFree.toFixed(3) + ' rs'));
      out.push(row('戰鬥・推進・反向對照：不推的話半徑掉了超過 1 rs（1 = 是）', r0 - rFree > 1 ? 1 : 0, 1, 0, 'abs'));

      // 引擎關掉 ＝ 測地線：跟 physics.js 的 trace 走出來的是同一條
      st = P.launch(H1, [8, 0, 0], [0.2, 0.3, 1], 0.33, 'ball');
      var ref = P.trace(H1, st, { tSpan: 400, rMax: 300, frac: 0.004, maxSteps: 400000 }), st2 = Float64Array.from(st);
      G.advanceTau(H1, st2, 40, [1, 0, 0], 0);
      q = P.sampleAt(ref, st2[3]);
      out.push(row('戰鬥・推進・反向對照：引擎關掉走 40 的固有時，跟物理核心的測地線差多遠（rs）', Math.hypot(st2[0] - q.x, st2[1] - q.y, st2[2] - q.z), 0, 2e-5, 'abs',
        '比的是同一個座標時間 t = ' + st2[3].toFixed(3) + ' 的位置；固有時差 ' + Math.abs(q.tau - 40).toExponential(1)));

      // 一邊繞一邊亂推，4-速度的長度不能跑掉（H = −1/2）
      st = P.launch(H1, [6, 0, 0], [0, 0, 1], 0.4, 'ball');
      for (i = 0; i < 300; i++) G.advanceTau(H1, st, 0.1, [Math.cos(i * 0.37), Math.sin(i * 0.61), Math.cos(i * 0.23 + 1)], 0.05);
      out.push(row('戰鬥・推進：在黑洞旁邊朝各種方向推 30 的固有時之後的 H（有質量粒子 = −1/2）', P.hamiltonian(H1, st), -0.5, 1e-7, 'abs', '此時 r = ' + Math.hypot(st[0], st[1], st[2]).toFixed(3) + ' rs'));

      // 邊界的空間扭曲：平直空間、以 0.6 c 直直往外衝進去。往回帶的固有加速度是 k·x ⇒ dγ/dx = −k x ⇒ 掉頭的地方 x = √(2(γ₀ − 1)/k)
      var wl = { R: W.CFG.wallR, k: W.CFG.wallK }, rTurn = 0, rNoWall;      // 用遊戲實際的設定
      st = P.launch(H0, [wl.R, 0, 0], [1, 0, 0], 0.6, 'ball');
      for (i = 0; i < 4000; i++) { G.advanceTau(H0, st, 0.02, null, 0, wl); if (st[0] > rTurn) rTurn = st[0]; else break; }
      st2 = P.launch(H0, [wl.R, 0, 0], [1, 0, 0], 0.6, 'ball');
      G.advanceTau(H0, st2, i * 0.02, null, 0, null); rNoWall = st2[0];
      out.push(row('戰鬥・邊界：以 0.6 c 往外衝進空間扭曲，最遠到哪才掉頭（rs）', rTurn, wl.R + Math.sqrt(2 * (1.25 - 1) / wl.k), 1e-4, 'rel',
        '扭曲從 ' + wl.R + ' rs 開始；解析值 R + √(2(γ₀ − 1)/k)。反向對照：同樣的時間沒有這一圈扭曲，已經飛到 ' + rNoWall.toFixed(1) + ' rs'));
      out.push(row('戰鬥・邊界・反向對照：沒有扭曲的話飛得比掉頭點遠（1 = 是）', rNoWall > rTurn + 1 ? 1 : 0, 1, 0, 'abs'));

      // 發射：光子 H = 0；動能彈 H = −1/2，而且「船看到它」的速度就是設定的出膛速度
      var shp = G.orbit(H1, 8, 0, 0.1, 1, 0, 1), g8 = P.metricCov(H1, shp.s);
      var ph = G.launch(H1, shp.s, [0.3, 0.2, 0.93], 1), sl = G.launch(H1, shp.s, [0.3, 0.2, 0.93], 0.45), us = G.velocity4(H1, shp.s), ub = G.velocity4(H1, sl);
      var gamRel = -P.dot(g8, ub, us);
      out.push(row('戰鬥・發射：從 0.27 c 的船上射出的光子的 H（零測地線 = 0）', P.hamiltonian(H1, ph), 0, 1e-12, 'abs'));
      out.push(row('戰鬥・發射：動能彈相對船的速度（設定 0.45 c）', Math.sqrt(1 - 1 / (gamRel * gamRel)), 0.45, 1e-9, 'rel', 'H = ' + P.hamiltonian(H1, sl).toFixed(12) + '（有質量 = −1/2）'));

      // 一發雷射：平直空間、兩艘都不動、機頭對機頭。打中的是對方機頭尖端那一格，不是一顆球
      function duel(tilt, kind, vTarget) {
        var w = new W(H0, { empty: true, cfg: { wallR: 0, enemySpread: 0, enemyAccel: 0 } }), c = Math.cos(tilt), sn = Math.sin(tilt);
        var me = w.addShip('player', P.launch(H0, [-5, 0, 0], [1, 0, 0], 0, 'ball'), [c, 0, sn], [0, 1, 0], { loadout: 'LKM', cool: 0 });
        var foe = w.addShip('enemy', P.launch(H0, [5, 0, 0], [-1, 0, 0], vTarget || 0, 'ball'), [-1, 0, 0], [0, 1, 0], { loadout: 'L', cool: 1e9 });
        w.player = me; me.cool = { laser: 0, kinetic: 0, missile: 0 };
        var res = { tHit: null, shots: 0, cells: 0, size: 0, world: w, foe: foe, tFire: null, x0: null };
        for (var n = 0; n < 1200 && res.tHit === null; n++) {
          w.step(0.04, { fire: n === 0, weapon: kind });
          var ev = w.takeEvents();
          for (var e2 = 0; e2 < ev.length; e2++) {
            if (ev[e2].type === 'shot') { res.shots++; res.tFire = ev[e2].shot.tr.T[0]; res.x0 = ev[e2].shot.tr.X[0]; }
            if (ev[e2].type === 'hit') { res.tHit = ev[e2].t; res.cells = ev[e2].cells.length; res.size = ev[e2].size; }
          }
        }
        return res;
      }
      a = duel(0, 'laser');
      var tipX = 5 - 0.5 * a.world.cfg.shipLen;      // 對方機頭尖端的位置
      out.push(row('戰鬥・雷射：平直空間機頭對機頭開一發，光從出膛到打中飛了多久', a.tHit === null ? -1 : a.tHit - a.tFire, tipX - a.x0, 0.01, 'abs',
        '出膛點 x = ' + (a.x0 === null ? NaN : a.x0).toFixed(4) + '，對方機頭尖端 x = ' + tipX.toFixed(4) + '；打掉 ' + a.cells + ' 格，對方的雷射發射器剩 ' + (100 * a.foe.vox.integrity(part('laser'))).toFixed(0) + '%'));
      out.push(row('戰鬥・雷射・反向對照：機頭偏 5° 再開（偏出去 0.87 rs，船寬才 0.29），有沒有打中（0 = 沒有）', duel(5 * Math.PI / 180, 'laser').tHit === null ? 0 : 1, 0, 0, 'abs'));

      // 動能彈：坑的大小看相對速度。對方不動時是 0.45 c；對方以 0.7563 c 迎面過來時相對速度是 0.9 c
      var kc = W.CFG.kinetic;
      function crater(v) { return kc.base + kc.gain * Math.cbrt(1 / Math.sqrt(1 - v * v) - 1); }
      a = duel(0, 'kinetic');
      var b9 = duel(0, 'kinetic', (0.9 - 0.45) / (1 - 0.9 * 0.45));
      out.push(row('戰鬥・動能：對方不動（相對 0.45 c）時坑的半徑（格）', a.size, crater(0.45), 1e-6, 'rel', '打掉 ' + a.cells + ' 格'));
      out.push(row('戰鬥・動能：對方迎面 0.756 c（相對 0.9 c）時坑的半徑（格）', b9.size, crater(0.9), 1e-4, 'rel', '打掉 ' + b9.cells + ' 格（相對速度照狹義相對論的速度疊加）'));

      // 船身的格子：從側面對著反應爐打。洞是真的洞 —— 同一個位置再打一發會直接穿過去
      (function () {
        var w = new W(H0, { empty: true, cfg: { wallR: 0 } });
        var tgt = w.addShip('enemy', P.launch(H0, [0, 0, 0], [1, 0, 0], 0, 'ball'), [0, 0, 1], [0, 1, 0], { loadout: 'LKM', cool: 1e9 });
        var by = { team: 'player' }, ri = part('reactor'), n0 = tgt.vox.count;
        function ray(mx, mz) {       // 從 −y 那一側、沿模型的 +y 方向，對著模型座標 (mx, *, mz) 打過去
          var p = w.fromModel(tgt, [mx, 59, mz]), side = G.cross(tgt.up, tgt.fwd);
          return w.rayHit(tgt, [p[0] - side[0], p[1] - side[1], p[2] - side[2]], [p[0] + side[0], p[1] + side[1], p[2] + side[2]], [0, 0, 0], [0, 0, 0]);
        }
        var h1 = ray(103, 18), yFirst = -1;
        for (var yy = 0; yy < M.dims[1] && yFirst < 0; yy++) if (M.grid[103 + M.dims[0] * (yy + M.dims[1] * 18)]) yFirst = yy;      // 直接掃格子：那一排第一個非空格
        w.strike(tgt, 'laser', h1, 0, 0, by);
        var after1 = tgt.vox.integrity(ri), h2 = ray(103, 18);
        out.push(row('戰鬥・格子：側面第一發打在船身側面第幾格（模型 y）', h1 ? h1.pos[1] : -1, yFirst, 0.5, 'abs', '直接掃格子，那一排第一個非空格是 y = ' + yFirst + '；鑽進去 ' + w.cfg.laser.depth + ' 格，反應爐剩 ' + (100 * after1).toFixed(1) + '%'));
        out.push(row('戰鬥・格子：同一個位置再打一發，有沒有打到東西（0 = 沒有，從洞裡穿過去了）', h2 ? 1 : 0, 0, 0, 'abs'));
        var shots = 1, pat = [[108, 18], [98, 18], [103, 22], [103, 14], [108, 22], [98, 14], [108, 14], [98, 22], [103, 20], [100, 16]];
        for (var j = 0; j < pat.length && tgt.alive; j++) { var hh = ray(pat[j][0], pat[j][1]); if (hh) { w.strike(tgt, 'laser', hh, 0, 0, by); shots++; } }
        out.push(row('戰鬥・格子：對著反應爐換位置連打，幾發之後船毀（反應爐剩不到一半）', tgt.alive ? -1 : shots, 5, 3, 'abs',
          '反應爐剩 ' + (100 * tgt.vox.integrity(ri)).toFixed(1) + '%，整艘船還剩 ' + (100 * tgt.vox.count / n0).toFixed(1) + '% 的格子 —— 是核心壞了，不是被削光'));
        // 反向對照：同樣的發數打在翼尖，船還活著
        var w2 = new W(H0, { empty: true, cfg: { wallR: 0 } }), t2 = w2.addShip('enemy', P.launch(H0, [0, 0, 0], [1, 0, 0], 0, 'ball'), [0, 0, 1], [0, 1, 0], { loadout: 'LKM', cool: 1e9 });
        for (j = 0; j < shots; j++) {
          var p2 = w2.fromModel(t2, [70 + 4 * j, 20, 60]), hw = w2.rayHit(t2, p2, w2.fromModel(t2, [70 + 4 * j, 20, -30]), [0, 0, 0], [0, 0, 0]);
          if (hw) w2.strike(t2, 'laser', hw, 0, 0, by);
        }
        out.push(row('戰鬥・格子・反向對照：同樣的發數打在機艙外側，船還活著（1 = 是）', t2.alive ? 1 : 0, 1, 0, 'abs',
          '少了 ' + (n0 - t2.vox.count) + ' 格，反應爐 ' + (100 * t2.vox.integrity(ri)).toFixed(0) + '%'));
        // 引擎：全部打壞之後推力是 0，按著推進鍵走出來的還是測地線
        var w3 = new W(H1, { empty: true, cfg: { wallR: 0 } }), o3 = G.orbit(H1, 8, 0, 0.2, 1, 0, 1);
        var p3 = w3.addShip('player', o3.s, null, null, { loadout: 'LKM' });
        w3.player = p3;
        var sA = Float64Array.from(p3.s);
        M.engines.forEach(function (e) { w3.strike(p3, 'missile', { pos: [e.x + 4, e.y, e.z], dir: [1, 0, 0] }, 0, 0, null); });
        for (j = 0; j < 200; j++) w3.step(0.05, { f: 1, boost: true });
        G.advanceTau(H1, sA, 10, null, 0, null);
        out.push(row('戰鬥・格子：五具引擎都打壞之後按著推進鍵飛 10 的固有時，跟不推差多遠（rs）', Math.hypot(p3.s[0] - sA[0], p3.s[1] - sA[1], p3.s[2] - sA[2]), 0, 1e-9, 'abs',
          '推力剩 ' + p3.thrust + '、引擎的遮罩 ' + p3.engMask + '、船還活著：' + p3.alive));
      })();

      // 射擊解（雷射）：射手在 8 rs 的圓軌道上（0.27 c），目標在黑洞另一側 6 rs 的軌道 —— 光要繞過去、目標在動、射手自己也在動
      var sh = G.orbit(H1, 8, 0, 0.1, 1, 0, 1), tg = G.orbit(H1, 6, 2.0, -0.2, -1, 0, 1);
      var tgTr = G.coast(H1, { x: tg.s[0], y: tg.s[1], z: tg.s[2], t: tg.s[3], px: tg.s[4], py: tg.s[5], pz: tg.s[6], pt: tg.s[7] }, 80);
      var sol = G.solveShot(H1, sh.s, tgTr, { speed: 1, range: 26, tol: 0.1 }), flat = G.solveShot(H1, sh.s, tgTr, { speed: 1, range: 26, tol: 0.1, flat: true });
      function fly(nose, v) { return P.trace(H1, G.launch(H1, sh.s, nose, v), { tSpan: 60, rMax: 400, frac: 0.006, maxSteps: 60000 }); }
      var noAb = G.norm([sol.tr.UX[0], sol.tr.UY[0], sol.tr.UZ[0]]), mTrue = missOf(fly(sol.nose, 1), tgTr), mNoAb = missOf(fly(noAb, 1), tgTr);
      out.push(row('戰鬥・射擊解（雷射）：照解出來的方向把機頭轉過去、真的發一顆光子，離目標最近多遠（rs）', mTrue, 0, 0.02, 'abs',
        '解算器自己報的差距 ' + sol.miss.toExponential(1) + '（修了 ' + sol.iters + ' 次）；光飛了 ' + (sol.tHit - sh.s[3]).toFixed(2) + ' 才到；船寬 0.29 rs'));
      out.push(row('戰鬥・射擊解・反向對照：只用直線估（不管光會彎）差超過一個船身（1 = 是）', flat.miss > 0.5 ? 1 : 0, 1, 0, 'abs', '直線估差 ' + flat.miss.toFixed(3) + ' rs'));
      out.push(row('戰鬥・射擊解・反向對照：不修光行差（機頭直接指著光該飛的方向）差超過一個船身（1 = 是）', mNoAb > 0.5 ? 1 : 0, 1, 0, 'abs',
        '射手 0.27 c：差 ' + mNoAb.toFixed(3) + ' rs；機頭實際要偏 ' + (Math.acos(Math.min(1, G.dot3(noAb, sol.nose))) * 180 / Math.PI).toFixed(2) + '°'));
      // 射擊解（動能）：同一個射手，目標在同一側的 6.5 rs 軌道。彈丸慢 ⇒ 飛得久、彎得多、提前量大，跟雷射的解不是同一個方向
      var tgK = G.orbit(H1, 6.5, 0.75, 0.15, 1, 0, 1);
      var tgKTr = G.coast(H1, { x: tgK.s[0], y: tgK.s[1], z: tgK.s[2], t: tgK.s[3], px: tgK.s[4], py: tgK.s[5], pz: tgK.s[6], pt: tgK.s[7] }, 80);
      var solK = G.solveShot(H1, sh.s, tgKTr, { speed: 0.45, range: 40, tol: 0.1 }), solL = G.solveShot(H1, sh.s, tgKTr, { speed: 1, range: 26, tol: 0.1 });
      var mK = missOf(fly(solK.nose, 0.45), tgKTr), mKwrong = missOf(fly(solL.nose, 0.45), tgKTr);
      out.push(row('戰鬥・射擊解（動能）：照解出來的方向真的射一顆 0.45 c 的彈丸，離目標最近多遠（rs）', mK, 0, 0.02, 'abs',
        '解算器報 ' + solK.miss.toExponential(1) + '（修了 ' + solK.iters + ' 次）；彈丸飛了 ' + (solK.tHit - sh.s[3]).toFixed(2) + '，同一個目標光只要 ' + (solL.tHit - sh.s[3]).toFixed(2)));
      out.push(row('戰鬥・射擊解・反向對照：拿雷射的解去射彈丸，差超過一個船身（1 = 是）', mKwrong > 0.5 ? 1 : 0, 1, 0, 'abs',
        '差 ' + mKwrong.toFixed(3) + ' rs；兩個解的機頭方向差 ' + (Math.acos(Math.min(1, G.dot3(solK.nose, solL.nose))) * 180 / Math.PI).toFixed(1) + '°'));

      // 飛彈：自己轉向追一艘在 7 rs 軌道上滑行的目標；反向對照是把它的引擎關掉（只剩出膛那一下）
      function chase(accel) {
        var w = new W(H1, { empty: true, seed: 5, cfg: { wallR: 0, missile: { accel: accel } } });
        var o1 = G.orbit(H1, 9, 0, 0.1, 1, 0, 1), o2 = G.orbit(H1, 7, 2.7427, 0.3, 1, -80, 1);
        var me = w.addShip('player', o1.s, null, null, { loadout: 'LKM', cool: 0 }), foe = w.addShip('enemy', o2.s, null, null, { loadout: 'L', cool: 1e9, hist: o2.tr });
        w.player = me; me.cool = { laser: 0, kinetic: 0, missile: 0 };
        var res = { why: null, cells: 0, t: 0, n0: foe.vox.count, foe: foe, fired: 0, d0: Math.hypot(o1.s[0] - o2.s[0], o1.s[1] - o2.s[1], o1.s[2] - o2.s[2]) };
        for (var n = 0; n < 1600 && res.why === null; n++) {
          if (n % 10 === 0) w.updatePlayerFC();
          w.step(0.05, { fire: n === 0, weapon: 'missile' });
          var ev = w.takeEvents();
          for (var e2 = 0; e2 < ev.length; e2++) { if (ev[e2].type === 'missile') res.fired++; if (ev[e2].type === 'missileEnd') { res.why = ev[e2].why; res.t = w.t; } if (ev[e2].type === 'hit') res.cells += ev[e2].cells.length; }
        }
        return res;
      }
      a = chase(W.CFG.missile.accel);
      var cold = chase(0);
      out.push(row('戰鬥・飛彈：追一艘在 7 rs 軌道上滑行的目標，結果（1 = 碰到船身）', a.why === 'hit' ? 1 : 0, 1, 0, 'abs',
        '發射時相距 ' + a.d0.toFixed(2) + ' rs；發射 ' + a.fired + ' 枚，飛了 ' + a.t.toFixed(1) + '（座標時間）之後「' + a.why + '」，打掉 ' + a.cells + ' 格（整艘 ' + a.n0 + ' 格）；目標還活著：' + a.foe.alive));
      out.push(row('戰鬥・飛彈・反向對照：把飛彈的引擎關掉，有沒有碰到（0 = 沒有）', cold.why === 'hit' ? 1 : 0, 0, 0, 'abs', '結果「' + cold.why + '」'));

      // 掉進去：穿過視界那一刻還活著（只記一筆），到奇異點才結束
      (function () {
        var w = new W(H1, { seed: 3 });
        w.waveAt = null;                                   // 這一項不要敵機
        var pl = w.player, s0 = P.launch(H1, [1.3, 0, 0], [1, 0, 0], 0, 'ball');
        s0[3] = pl.s[3]; pl.s.set(s0);
        var tauCross = null, tauDead = null, aliveAtCross = 0, rCross = 0;
        for (var n = 0; n < 4000 && w.state === 'play'; n++) {
          w.step(0.004, {});
          var ev = w.takeEvents();
          for (var e2 = 0; e2 < ev.length; e2++) {
            if (ev[e2].type === 'cross') { tauCross = w.tau; aliveAtCross = w.state === 'play' && pl.alive ? 1 : 0; rCross = G.radius(H1, pl.s); }
            if (ev[e2].type === 'dead') tauDead = w.tau;
          }
        }
        out.push(row('戰鬥・視界：穿過視界那一刻遊戲還在進行（1 = 是）', aliveAtCross, 1, 0, 'abs', '那一刻 r = ' + rCross.toFixed(4) + ' rs'));
        out.push(row('戰鬥・視界：結束的原因是到奇異點、而且在穿過視界之後（1 = 是）', w.reason === 'singularity' && tauDead > tauCross ? 1 : 0, 1, 0, 'abs',
          '穿過視界之後自己的時間又過了 ' + (tauDead - tauCross).toFixed(3) + ' rs/c 才到 r = ' + G.radius(H1, pl.s).toFixed(3) + ' rs'));
      })();

      // 標記投影：平直空間、攝影機以 0.5 c 往前飛，旁邊 60° 的東西看起來被擠到前面（光行差）
      var pm = P.launch(H0, [0, 0, 0], [1, 0, 0], 0.5, 'ball');
      var cf = G.cameraFrame(H0, [0, 0, 0], [pm[4], pm[5], pm[6]], [1, 0, 0], [0, 1, 0]);
      var pj = G.project(H0, cf, [10 * Math.cos(Math.PI / 3), 0, 10 * Math.sin(Math.PI / 3)]);
      out.push(row('戰鬥・標記：0.5 c 往前飛時，靜止系裡偏 60° 的東西在畫面上偏幾度', Math.atan2(Math.hypot(pj[0], pj[1]), pj[2]) * 180 / Math.PI, Math.acos((0.5 + 0.5) / (1 + 0.25)) * 180 / Math.PI, 1e-6, 'rel',
        '光行差公式 cos θ′ = (cos θ + v) / (1 + v cos θ)'));

      // 看到的是過去：等速飛的船，觀察者看到的那一刻 te 滿足 te + 距離 = 現在
      (function () {
        var w = new W(H0, { empty: true, cfg: { wallR: 0 } });
        var s3 = w.addShip('enemy', P.launch(H0, [0, 0, 0], [1, 0, 0], 0.6, 'ball'), null, null, { cool: 1e9 });
        w.player = w.addShip('player', P.launch(H0, [0, 30, 0], [1, 0, 0], 0, 'ball'), null, null, { loadout: 'LKM' });
        for (var n = 0; n < 500; n++) w.step(0.1, {});
        var obs = [0, 30, 0], rt = w.retarded(s3.hist, obs, w.t);
        out.push(row('戰鬥・光行時間：看到的那一刻 ＋ 光走的距離 − 現在', rt.t + Math.hypot(rt.x - obs[0], rt.y - obs[1], rt.z - obs[2]) - w.t, 0, 1e-6, 'abs',
          '現在 t = ' + w.t.toFixed(1) + '，看到的是 t = ' + rt.t.toFixed(2) + ' 的它（那時在 x = ' + rt.x.toFixed(2) + '，現在其實在 x = ' + s3.s[0].toFixed(2) + '）'));
      })();

      // 整場交給自動飛行＋自動開火跑一段：不出現 NaN、三種武器都有用到；同一個種子兩次結果一樣
      function soak(seed) {
        var w = new W(H1, { seed: seed }), res = { bad: 0, spawned: 0, hits: 0, parts: 0, kills: 0 };
        for (var n = 0; n < 1500 && w.state === 'play'; n++) {
          if (n % 6 === 0) w.updatePlayerFC();
          w.step(0.05, { autoFly: true, autoFire: true });
          var ev = w.takeEvents();
          for (var e2 = 0; e2 < ev.length; e2++) { var ty = ev[e2].type; if (ty === 'spawn') res.spawned++; if (ty === 'hit') res.hits++; if (ty === 'part') res.parts++; if (ty === 'kill') res.kills++; }
          for (var j = 0; j < w.ships.length; j++) if (!isFinite(w.ships[j].s[0] + w.ships[j].s[3] + w.ships[j].s[7])) res.bad++;
        }
        res.w = w; res.t = w.t;
        return res;
      }
      var k1 = soak(7), k2 = soak(7), sk = k1.w.stats;
      out.push(row('戰鬥・整場：自動飛行＋自動開火跑 75 的固有時，壞掉的數字（NaN）幾個', k1.bad, 0, 0, 'abs',
        '敵機 ' + k1.spawned + ' 艘、第 ' + k1.w.wave + ' 波、命中事件 ' + k1.hits + '、壞掉的部位 ' + k1.parts + '、擊毀 ' + k1.kills + '、狀態 ' + k1.w.state + (k1.w.reason ? '（' + k1.w.reason + '）' : '')));
      out.push(row('戰鬥・整場：三種武器都自己開過火（1 = 是）', sk.laser.shots > 0 && sk.kinetic.shots > 0 && sk.missile.shots > 0 ? 1 : 0, 1, 0, 'abs',
        '雷射 ' + sk.laser.hits + '／' + sk.laser.shots + '、動能 ' + sk.kinetic.hits + '／' + sk.kinetic.shots + '、飛彈 ' + sk.missile.hits + '／' + sk.missile.shots + '（命中／發射）'));
      out.push(row('戰鬥・整場：同一個種子跑兩次，結束時的座標時間差', k1.t - k2.t, 0, 0, 'abs', '兩次都是 t = ' + k1.t.toFixed(6)));

      // ── 體素破壞：斷開的格子群變成破片、船毀了斷成幾截；雷射是一段光束 ──
      (function () {
        function cutShip(yEnd) {      // 在 x = 70 那一排，從右舷往左舷一顆一顆打（坑的半徑 14 格），打到 y = yEnd 為止
          var w = new W(H0, { empty: true, cfg: { wallR: 0 } });
          var sh = w.addShip('enemy', P.launch(H0, [0, 0, 0], [1, 0, 0], 0.3, 'ball'), [1, 0, 0], [0, 1, 0], { loadout: 'LKM', cool: 1e9 });
          sh.tough = 0;                // 這裡只看格子：不要讓它打到一半被判定擊毀
          var res = { w: w, sh: sh, n0: sh.vox.count, gone: 0, carved: 0, fr: [], big: 0, inFrags: 0 };
          for (var y = 4; y <= yEnd; y += 11) w.strike(sh, 'kinetic', { pos: [70, y, 20], dir: [0, 0, -1] }, 14, w.t, null);
          var ev = w.takeEvents();
          for (var j = 0; j < ev.length; j++) {
            if (ev[j].type === 'hit') { res.gone += ev[j].cells.length; res.carved += ev[j].carved; }
            if (ev[j].type === 'frag') { res.fr.push(ev[j].frag); res.big = Math.max(res.big, ev[j].frag.n); res.inFrags += ev[j].frag.n; }
          }
          return res;
        }
        var full = cutShip(114), part2 = cutShip(48), sizes = full.fr.map(function (f) { return f.n; }).join('、');
        out.push(row('戰鬥・破壞：格子數守恆 —— 原本的 − 剩下的 − 事件裡說拿掉的', full.n0 - full.sh.vox.count - full.gone, 0, 0, 'abs',
          '原本 ' + full.n0 + ' 格；被挖掉 ' + full.carved + '、因為斷開而掉下來 ' + (full.gone - full.carved) + '（其中 ' + full.inFrags + ' 格變成 ' + full.fr.length + ' 塊破片：' + sizes + '），剩 ' + full.sh.vox.count));
        out.push(row('戰鬥・破壞：打完之後剩下的船身是完整的一塊（還有幾群跟主體斷開）', full.sh.vox.loose(full.w.seedOf(full.sh)).length, 0, 0, 'abs'));
        out.push(row('戰鬥・破壞：整排打穿 ⇒ 船身斷成兩截（最大的那塊破片 ÷ 整艘船 > 0.2 記 1）', full.big / full.n0 > 0.2 ? 1 : 0, 1, 0, 'abs',
          '最大的一塊 ' + full.big + ' 格（' + (100 * full.big / full.n0).toFixed(1) + '%）。反向對照見下一項'));
        out.push(row('戰鬥・破壞・反向對照：只打穿一半 ⇒ 沒有斷成兩截（最大的破片 ÷ 整艘船 < 0.2 記 1）', part2.big / part2.n0 < 0.2 ? 1 : 0, 1, 0, 'abs',
          '最大的一塊 ' + part2.big + ' 格（' + (100 * part2.big / part2.n0).toFixed(1) + '%），破片 ' + part2.fr.length + ' 塊'));
        // 破片從哪裡出發、飄多快：位置 ＝ 它的重心在船上的位置；相對船的速度在設定的範圍裡
        var f0 = full.fr[0], sh0 = full.sh, p0 = full.w.fromModel(sh0, f0.com), us = G.velocity4(H0, sh0.s);
        var gam = -P.dot(P.metricCov(H0, sh0.s), [f0.tr.UX[0], f0.tr.UY[0], f0.tr.UZ[0], f0.tr.UT[0]], us), vrel = Math.sqrt(Math.max(0, 1 - 1 / (gam * gam))), cf2 = W.CFG.frag;
        out.push(row('戰鬥・破壞：破片的出發點離「它的重心在船上的位置」多遠（rs）', Math.hypot(f0.tr.X[0] - p0[0], f0.tr.Y[0] - p0[1], f0.tr.Z[0] - p0[2]), 0, 1e-9, 'abs'));
        out.push(row('戰鬥・破壞：破片相對船的速度在設定的範圍裡（1 = 是）', vrel >= 0.6 * 0.8 * cf2.speed - 1e-9 && vrel <= 1.4 * 2.5 * cf2.speed + 1e-9 ? 1 : 0, 1, 0, 'abs',
          '量到 ' + vrel.toFixed(5) + ' c；範圍 ' + (0.48 * cf2.speed).toFixed(4) + '～' + (3.5 * cf2.speed).toFixed(4) + '（船自己是 0.3 c）'));
        // 船毀了：剩下的每一格都分到某一截裡
        var wk = new W(H0, { empty: true, cfg: { wallR: 0 } }), sk2 = wk.addShip('enemy', P.launch(H0, [0, 0, 0], [1, 0, 0], 0.3, 'ball'), [1, 0, 0], [0, 1, 0], { cool: 1e9 });
        var before = sk2.vox.count;
        sk2.lastHit = [150, 40, 20];
        wk.kill(sk2, 'core', null);
        var wr = wk.takeEvents().filter(function (e3) { return e3.type === 'frag'; }).map(function (e3) { return e3.frag; }), wsum = wr.reduce(function (m2, f) { return m2 + f.n; }, 0);
        out.push(row('戰鬥・破壞：船毀了之後斷成幾截，各截的格子數加起來 − 原本的', wsum - before, 0, 0, 'abs',
          wr.length + ' 截：' + wr.map(function (f) { return f.n; }).join('、') + ' 格；船自己剩 ' + sk2.vox.count + ' 格'));
        out.push(row('戰鬥・破壞：斷成至少兩截（1 = 是）', wr.length >= 2 ? 1 : 0, 1, 0, 'abs'));

        // 光束：平直空間、船以 0.5 c 斜著飛。晚 dl 出發的光子 ＝ 第一顆的位置 + dl × E，E 應該是 船的速度 − 光的速度
        var Bd = node ? require('./bodies.js') : root.BH.Bodies;
        var wb = new W(H0, { empty: true, cfg: { wallR: 0 } });
        var sb = wb.addShip('player', P.launch(H0, [0, 0, 0], G.norm([0.6, 0, 0.8]), 0.5, 'ball'), [1, 0, 0], [0, 1, 0], { loadout: 'L', cool: 0 });
        wb.player = sb;
        var shot = wb.fire(sb, 'laser');
        if (!shot || !shot.beam || !Bd) { out.push(row('戰鬥・光束：射得出來（1 = 是）', 0, 1, 0, 'abs')); return; }
        var bf = Bd.beamFrame(shot.tr, shot.beam, 64), ub = G.velocity4(H0, sb.s), vs = [ub[0] / ub[3], ub[1] / ub[3], ub[2] / ub[3]];
        var hq = P.sampleAt(shot.tr, shot.tr.T[0] + 3), nn = [hq.ux / hq.ut, hq.uy / hq.ut, hq.uz / hq.ut], kq = 20;
        var eErr = Math.hypot(bf.fwd[4 * kq] - (vs[0] - nn[0]), bf.fwd[4 * kq + 1] - (vs[1] - nn[1]), bf.fwd[4 * kq + 2] - (vs[2] - nn[2]));
        out.push(row('戰鬥・光束：E 跟「船的速度 − 光的速度」差多少', eErr, 0, 1e-6, 'abs',
          '船速 (' + vs.map(function (x2) { return x2.toFixed(3); }).join(', ') + ')、光 (' + nn.map(function (x2) { return x2.toFixed(3); }).join(', ') + ')；光束持續 ' + shot.beam.dur.toFixed(3) + '。所以光束的尾端一直接在還在動的發射口上'));
        out.push(row('戰鬥・光束：最後一顆光子比第一顆晚多久到終點（÷ 持續時間）', bf.lam, 1 - (vs[0] * nn[0] + vs[1] * nn[1] + vs[2] * nn[2]), 1e-6, 'abs', '解析值 1 − 船速·光的方向（船追著自己的光跑，光束在路上被壓短）'));
        out.push(row('戰鬥・光束・反向對照：船不動的話 E 就只是「往後」，跟上面差多少（> 0.3 記 1）', Math.hypot(vs[0], vs[1], vs[2]) > 0.3 ? 1 : 0, 1, 0, 'abs', '差的就是船速 ' + Math.hypot(vs[0], vs[1], vs[2]).toFixed(3) + ' c'));

        // 連續開火：一段接一段。船以 0.5 c 飛、一邊轉頭一邊按住開火 3 的固有時（能量給到用不完）
        var wc = new W(H0, { empty: true, cfg: { wallR: 0, energyRegen: 100 } });
        var sc = wc.addShip('player', P.launch(H0, [0, 0, 0], G.norm([0.6, 0, 0.8]), 0.5, 'ball'), [1, 0, 0], [0, 1, 0], { loadout: 'L', cool: 0 });
        wc.player = sc;
        var shots = [], muzzleErr = 0, liveSeen = 0, n3, j3;
        for (n3 = 0; n3 < 60; n3++) {
          wc.rotatePlayer(0.02, 0, 0);
          wc.step(0.05, { fire: true, weapon: 'laser' });
          var ev3 = wc.takeEvents();
          for (j3 = 0; j3 < ev3.length; j3++) if (ev3[j3].type === 'shot') shots.push(ev3[j3].shot);
          var lb = sc.lastBeam;
          if (lb && lb.beam.live && sc.tau > lb.tau0) {      // 還在射的那一段：尾端那顆光子就是這一格從發射口射出去的
            var mz = wc.fromModel(sc, lb.part.muzzle), tl = lb.beam.tail;
            muzzleErr = Math.max(muzzleErr, Math.hypot(tl.X[0] - mz[0], tl.Y[0] - mz[1], tl.Z[0] - mz[2]) + Math.abs(tl.T[0] - wc.t));
            liveSeen++;
          }
        }
        var unlinked = 0, durErr = 0, notSame = 0, gamC = G.velocity4(H0, sc.s)[3];
        for (j3 = 0; j3 + 1 < shots.length; j3++) {
          if (!shots[j3].beam.linked || !shots[j3 + 1].beam.linkedStart) unlinked++;
          if (shots[j3].beam.tail !== shots[j3 + 1].tr) notSame++;
          durErr = Math.max(durErr, Math.abs(shots[j3].beam.dur - (shots[j3 + 1].tr.T[0] - shots[j3].tr.T[0])));
        }
        out.push(row('戰鬥・光束：按住開火，前後兩段沒有接起來的有幾處', shots.length >= 4 ? unlinked + notSame : NaN, 0, 0, 'abs',
          '射了 ' + shots.length + ' 段；每一段的「最後一顆光子」就是下一段的第一顆（同一條路）。兩段之間隔 ' + ((shots[1].tr.T[0] - shots[0].tr.T[0]) / gamC).toFixed(3) + '（船的鐘）＝ ' + (shots[1].tr.T[0] - shots[0].tr.T[0]).toFixed(3) + '（外面的鐘）'));
        out.push(row('戰鬥・光束：每一段持續多久 − 到下一段開火隔多久（差多少就是接頭的縫或重疊）', durErr, 0, 0, 'abs', '修之前：每段固定 0.6（外面的鐘），間隔卻是 0.55 × 船的時間流速 ＋ 一格，接頭會空一截'));
        // 接頭：中間那一段的尾端（第一顆的位置 + 持續時間 × E）跟下一段的第一顆光子，同一時刻要在同一個地方
        var sA = shots[1], sB = shots[2], bfA = Bd.beamFrame(sA.tr, sA.beam, 256), jErr = 0, jN = 0;
        for (j3 = 0; j3 < 256; j3++) {
          var Tj = sA.tr.T[0] + (sA.tr.T[sA.tr.n - 1] - sA.tr.T[0]) * j3 / 255;
          if (Tj < sB.tr.T[0] + 0.01 || Tj > sB.tr.T[sB.tr.n - 1]) continue;
          var hA = P.sampleAt(sA.tr, Tj), hB = P.sampleAt(sB.tr, Tj);
          jErr = Math.max(jErr, Math.hypot(hA.x + bfA.fwd[4 * j3] * sA.beam.dur - hB.x, hA.y + bfA.fwd[4 * j3 + 1] * sA.beam.dur - hB.y, hA.z + bfA.fwd[4 * j3 + 2] * sA.beam.dur - hB.z));
          jN++;
        }
        out.push(row('戰鬥・光束：接頭兩邊在同一時刻差多遠（rs）', jN ? jErr : NaN, 0, 1e-6, 'abs', '比了 ' + jN + ' 個時刻；船在這一段裡轉了 ' + (0.02 * (sB.tr.T[0] - sA.tr.T[0]) / gamC / 0.05).toFixed(2) + ' 弧度（光束是折線，但接得上）'));
        out.push(row('戰鬥・光束：還在射的那一段，尾端那顆光子離發射口多遠（位置 ＋ 時刻的差）', liveSeen ? muzzleErr : NaN, 0, 1e-9, 'abs', '檢查了 ' + liveSeen + ' 格：每一格都換成當下射出去的那一顆，所以轉頭的時候光束不會跟機頭脫節'));
        // 只點一下：射滿 beam 這麼久（船的鐘）就停
        var w1 = new W(H0, { empty: true, cfg: { wallR: 0 } });
        var s1b = w1.addShip('player', P.launch(H0, [0, 0, 0], G.norm([0.6, 0, 0.8]), 0.5, 'ball'), [1, 0, 0], [0, 1, 0], { loadout: 'L', cool: 0 });
        w1.player = s1b;
        w1.step(0.05, { fire: true, weapon: 'laser' });
        var one = w1.takeEvents().filter(function (e3) { return e3.type === 'shot'; })[0].shot;
        for (n3 = 0; n3 < 30; n3++) w1.step(0.05, {});
        out.push(row('戰鬥・光束：只點一下，這一段照船自己的鐘持續多久', one.beam.dur / G.velocity4(H0, s1b.s)[3], W.CFG.laser.beam, 0.0501, 'abs',
          '設定 ' + W.CFG.laser.beam + '，一格 0.05 ⇒ 落在 ' + W.CFG.laser.beam + '～' + (W.CFG.laser.beam + 0.05).toFixed(2) + '；外面的鐘看是 ' + one.beam.dur.toFixed(3) + '。還在射 = ' + one.beam.live + '、有接下一段 = ' + one.beam.linked));
      })();
    })();

    // ── 背景的星空（js/stars.js、js/stars_data.js）：真的星表 ──
    (function () {
      var St = node ? require('./stars.js') : root.BH.Stars, SD = node ? require('./stars_data.js') : root.BH.StarData;
      if (!St || !SD) { out.push(row('星表載入了沒有（1 = 有）', 0, 1, 0, 'abs', '少了 js/stars.js 或 js/stars_data.js')); return; }
      var s = St.decode(SD), RAD = Math.PI / 180, j;
      function sep(a, b) { return Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) / RAD; }
      function dirOf(k) { return [s.dir[3 * k], s.dir[3 * k + 1], s.dir[3 * k + 2]]; }
      function eqSep(ra1, de1, ra2, de2) {      // 兩個赤經赤緯之間的角距（球面三角，跟模擬的座標無關）
        return Math.acos(Math.sin(de1 * RAD) * Math.sin(de2 * RAD) + Math.cos(de1 * RAD) * Math.cos(de2 * RAD) * Math.cos((ra1 - ra2) * RAD)) / RAD;
      }
      function nearest(ra, de) {                // 星表裡離這個赤經赤緯最近的那一顆
        var best = -1, bd = 1e9;
        for (var k = 0; k < s.n; k++) { var d2 = eqSep(ra, de, s.ra[k], s.dec[k]); if (d2 < bd) { bd = d2; best = k; } }
        return { i: best, d: bd };
      }
      out.push(row('星空：星表解出來幾顆', s.n, SD.n, 0, 'abs', SD.source + '；轉檔時跳過 ' + SD.check.skipped + ' 筆沒有位置的'));
      out.push(row('星空：校驗碼（JS 解碼後算的 − Python 轉檔時算的）', s.fnv, SD.fnv, 0, 'abs'));
      // 最亮的一顆是天狼星：赤經 6h45m08.9s、赤緯 −16°42′58″（J2000），−1.46 等
      out.push(row('星空：最亮那一顆離天狼星的位置幾度', eqSep(s.ra[0], s.dec[0], 101.2871, -16.7161), 0, 0.01, 'abs',
        '星表：赤經 ' + s.ra[0].toFixed(4) + '°、赤緯 ' + s.dec[0].toFixed(4) + '°、' + s.mag[0].toFixed(2) + ' 等（存成 6 bytes 之後的值；位置一格 0.0055°）'));
      // 參宿四（5h55m10.3s, +7°24′25″）與參宿七（5h14m32.3s, −8°12′06″）：在模擬座標裡的夾角 ＝ 球面三角算的夾角（擺進模擬只是轉一下，角度不變）
      var bet = nearest(88.7929, 7.4069), rig = nearest(78.6346, -8.2017), want = eqSep(88.7929, 7.4069, 78.6346, -8.2017);
      out.push(row('星空：參宿四與參宿七在模擬座標裡的夾角（度）', sep(dirOf(bet.i), dirOf(rig.i)), want, 0.01, 'abs',
        '星表裡找到的兩顆：' + s.mag[bet.i].toFixed(2) + ' 等（色指數 ' + s.bv[bet.i].toFixed(2) + '，紅）與 ' + s.mag[rig.i].toFixed(2) + ' 等（色指數 ' + s.bv[rig.i].toFixed(2) + '，藍白），各離文獻位置 ' + bet.d.toFixed(4) + '°、' + rig.d.toFixed(4) + '°'));
      // 天球怎麼擺：銀河中心（17h45m37.2s, −28°56′10″）要落在 GAL_C、北銀極（12h51m26.3s, +27°07′42″）要落在 GAL_N
      out.push(row('星空：銀河中心的方向離著色器畫銀河用的中心幾度', sep(St.toWorld(266.40499, -28.93617), St.GAL_C), 0, 0.01, 'abs'));
      out.push(row('星空：北銀極的方向離著色器畫銀河用的法線幾度', sep(St.toWorld(192.85948, 27.12825), St.GAL_N), 0, 0.01, 'abs',
        '轉檔時另外拿星表自己附的銀經銀緯對過 9,096 顆：最大差 ' + SD.check.galMaxErrDeg + '°（那幾顆是自行很大的星）'));
      // 是轉、不是鏡射：三個軸的行列式 = +1（鏡射的話星座會左右顛倒）
      var cz = [St.GAL_C[1] * St.GAL_Y[2] - St.GAL_C[2] * St.GAL_Y[1], St.GAL_C[2] * St.GAL_Y[0] - St.GAL_C[0] * St.GAL_Y[2], St.GAL_C[0] * St.GAL_Y[1] - St.GAL_C[1] * St.GAL_Y[0]];
      var M = St.EQ2GAL, det = M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
      out.push(row('星空：天球擺進模擬是旋轉不是鏡射（兩個行列式相乘 = +1）', det * (cz[0] * St.GAL_N[0] + cz[1] * St.GAL_N[1] + cz[2] * St.GAL_N[2]), 1, 1e-6, 'abs'));
      // 真的星往銀河面集中：銀緯 ±10° 以內的比例，均勻的話是 sin 10° = 17.4%。反向對照：換一個跟銀河無關的平面來數
      var nGal = 0, nOther = 0, lim = Math.sin(10 * RAD);
      for (j = 0; j < s.n; j++) { var dj = dirOf(j); if (Math.abs(dj[0] * St.GAL_N[0] + dj[1] * St.GAL_N[1] + dj[2] * St.GAL_N[2]) < lim) nGal++; if (Math.abs(dj[0] * St.GAL_C[0] + dj[1] * St.GAL_C[1] + dj[2] * St.GAL_C[2]) < lim) nOther++; }
      out.push(row('星空：銀緯 ±10° 以內的星佔幾成（均勻的話 0.174）—— 超過 0.22 記 1', nGal / s.n > 0.22 ? 1 : 0, 1, 0, 'abs',
        '量到 ' + (nGal / s.n).toFixed(3) + '。反向對照：改數「離一個跟銀河面垂直的平面 ±10° 以內」的是 ' + (nOther / s.n).toFixed(3)));
      // 分格：每顆星在自己的方向、以及光暈邊緣的八個方向上，都查得到自己（著色器只讀一格）
      var grid = St.buildGrid(s, 28, 28, 0.0052), miss = 0, tested = 0;
      for (j = 0; j < s.n; j++) {
        var d = dirOf(j), r = Math.max(St.haloRadius(s.mag[j]), 1.25 * 0.0052 * (1 + 0.5 * Math.max(0, 3 - s.mag[j]))) * 1.8;
        var ax = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], e1 = [d[1] * ax[2] - d[2] * ax[1], d[2] * ax[0] - d[0] * ax[2], d[0] * ax[1] - d[1] * ax[0]], l1 = Math.hypot(e1[0], e1[1], e1[2]);
        e1 = [e1[0] / l1, e1[1] / l1, e1[2] / l1];
        var e2 = [d[1] * e1[2] - d[2] * e1[1], d[2] * e1[0] - d[0] * e1[2], d[0] * e1[1] - d[1] * e1[0]];
        for (var kk = 0; kk < 9; kk++) {
          var an = kk * Math.PI / 4, rr = kk === 8 ? 0 : r, qv = [d[0] + rr * (Math.cos(an) * e1[0] + Math.sin(an) * e2[0]), d[1] + rr * (Math.cos(an) * e1[1] + Math.sin(an) * e2[1]), d[2] + rr * (Math.cos(an) * e1[2] + Math.sin(an) * e2[2])];
          var ql = Math.hypot(qv[0], qv[1], qv[2]), found = false, L = St.lookup(grid, [qv[0] / ql, qv[1] / ql, qv[2] / ql]);
          for (var m2 = 0; m2 < L.length; m2++) if (Math.hypot(L[m2].dir[0] - d[0], L[m2].dir[1] - d[1], L[m2].dir[2] - d[2]) < 1e-6) { found = true; break; }
          tested++; if (!found) miss++;
        }
      }
      out.push(row('星空：分格之後查不到自己的次數 ÷ 查的次數（每顆星查 9 個方向）', miss / tested, 0, 5e-4, 'abs',
        '查 ' + tested + ' 次、查不到 ' + miss + ' 次；最擠的一格 ' + grid.maxPer + ' 顆（上限 ' + grid.K + '），因為格子滿了沒放進去的 ' + grid.dropped + ' 次 —— 被擠掉的是那一格裡最暗的'));
    })();

    return out;
  }

  function format(rows) {
    var lines = [], bad = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r.pass) bad++;
      lines.push((r.pass ? '  ' : '✗ ') + r.name);
      lines.push('      量到 ' + fmt(r.got) + '   解析值 ' + fmt(r.want) + '   ' + (r.how === 'abs' ? '絕對' : '相對') + '誤差 ' + r.err.toExponential(2) + '（容許 ' + r.tol.toExponential(1) + '）' + (r.note ? '\n      ' + r.note : ''));
    }
    lines.push('');
    lines.push('項目 ' + rows.length + '，沒過 ' + bad);
    return { text: lines.join('\n'), bad: bad, total: rows.length };
  }
  function fmt(v) { return (Math.abs(v) >= 1e-3 && Math.abs(v) < 1e6) || v === 0 ? (+v.toPrecision(9)).toString() : v.toExponential(4); }

  var api = { run: run, format: format, row: row };
  root.BH = root.BH || {};
  root.BH.SelfTest = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    if (require.main === module) {
      var res = format(run());
      console.log(res.text);
      process.exit(res.bad ? 1 : 0);
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
