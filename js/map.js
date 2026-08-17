/**
 * 杭州生态地图（v2.0）
 * ==================================================================
 * 把 60 个物种（30 动物 + 30 植物）按栖息地散布到一张自绘的杭州意象
 * SVG 地图上。地图支持：滚轮以光标为中心缩放、左键按住拖拽平移、方向键
 * 平移，另有 ➕ ➖ 与「重置视图」。点击某个物种标记 → 进入原有的 15 秒
 * 限时识别答题流程（复用 window.HZGame.startChallenge，答题/计分/AI 校
 * 验逻辑完全不变）。
 *
 * 纯前端自绘，无外部地图库、无联网瓦片。
 * ------------------------------------------------------------------
 */
(function () {
  "use strict";
  const SVGNS = "http://www.w3.org/2000/svg";
  const BASE = { x: 0, y: 0, w: 1000, h: 680 };  // 逻辑坐标系
  const MIN_SCALE = 1;      // 1 = 完整铺满，不能再缩小
  const MAX_SCALE = 5;      // 最大放大倍数
  const MARKER_R = 17;      // 标记半径（逻辑单位，fit 状态下）

  // 稳定哈希：让同一物种每次落点一致
  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < String(str).length; i++) {
      h ^= String(str).charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0);
  }
  const rand01 = (seed) => (hash(seed) % 100000) / 100000;

  /* ---------- 分区：散布范围（rect）+ 标注 ---------- */
  const ZONES = {
    mountain: { x: 30,  y: 90,  w: 205, h: 430, label: "🌲 西部山林", lx: 60,  ly: 130 },
    xixi:     { x: 250, y: 70,  w: 220, h: 175, label: "💧 西溪湿地", lx: 275, ly: 100 },
    xihu:     { x: 430, y: 275, w: 195, h: 185, label: "〰️ 西湖",     lx: 470, ly: 300 },
    tea:      { x: 375, y: 480, w: 195, h: 130, label: "🍃 龙井茶园", lx: 400, ly: 515 },
    urban:    { x: 645, y: 180, w: 265, h: 250, label: "🏙️ 城区",     lx: 700, ly: 210 },
    farm:     { x: 660, y: 70,  w: 285, h: 95,  label: "🌾 农田稻区", lx: 700, ly: 100 },
    qiantang: { x: 560, y: 475, w: 415, h: 175, label: "≈ 钱塘江",    lx: 620, ly: 620 }
  };

  /* ---------- 物种 → 分区（栖息地关键词匹配） ---------- */
  function zoneFor(sp) {
    const h = sp.habitat || "";
    const has = (kws) => kws.some((k) => h.indexOf(k) >= 0);
    if (has(["钱塘江", "入海", "河口", "江滩", "洄游"])) return "qiantang";
    // 西部山林 / 茶园（山地系）
    if (has(["天目山", "临安", "西部山林", "山林", "竹海", "竹", "余杭", "丘陵",
             "灵隐", "九溪", "龙井", "梅家坞", "狮峰", "茶园", "满觉陇", "坡地", "山坡", "墓地"])) {
      if (has(["龙井", "梅家坞", "狮峰", "茶园", "满觉陇"])) return "tea";
      return "mountain";
    }
    const inXihu = has(["西湖", "苏堤", "白堤", "太子湾", "曲院风荷", "孤山", "植物园", "灵峰"]);
    const inXixi = has(["西溪", "湿地"]);
    if (inXihu && inXixi) return (hash(sp.id) % 2 === 0) ? "xihu" : "xixi";
    if (inXixi) return "xixi";
    if (inXihu) return "xihu";
    if (has(["稻田", "农田", "田野", "田埂"])) return "farm";
    // 泛水域 → 西湖/西溪 二选一（按 id 分流）
    if (has(["荷塘", "池塘", "静水", "湖荡", "水景", "溪", "水岸", "河荡", "河道", "湿"])) {
      return (hash(sp.id) % 2 === 0) ? "xihu" : "xixi";
    }
    return "urban";  // 公园/行道/庭院/城区/校园/绿地/草坪/主干道 等
  }

  /* ---------- 在分区内做确定性网格散布 ---------- */
  function layout(list) {
    const byZone = {};
    list.forEach((sp) => {
      const z = zoneFor(sp);
      (byZone[z] = byZone[z] || []).push(sp);
    });
    const placed = [];
    Object.keys(byZone).forEach((zid) => {
      const zone = ZONES[zid];
      const members = byZone[zid].slice().sort((a, b) => hash(a.id) - hash(b.id));
      const n = members.length;
      const cols = Math.max(1, Math.round(Math.sqrt(n * (zone.w / zone.h))));
      const rows = Math.max(1, Math.ceil(n / cols));
      const cellW = zone.w / cols, cellH = zone.h / rows;
      members.forEach((sp, i) => {
        const c = i % cols, r = Math.floor(i / cols);
        const jx = 0.2 + 0.6 * rand01(sp.id + "x");
        const jy = 0.2 + 0.6 * rand01(sp.id + "y");
        sp._mx = zone.x + cellW * (c + jx);
        sp._my = zone.y + cellH * (r + jy);
        sp._zone = zid;
        placed.push(sp);
      });
    });
    return placed;
  }

  /* ---------- 自绘杭州意象底图（装饰用 SVG 片段） ---------- */
  function backgroundSVG() {
    const zoneLabels = Object.keys(ZONES).map((k) => {
      const z = ZONES[k];
      return `<text class="mp-zone-label" x="${z.lx}" y="${z.ly}">${z.label}</text>`;
    }).join("");
    return `
      <defs>
        <linearGradient id="mpLand" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#0f3a30"/><stop offset="1" stop-color="#0a2620"/>
        </linearGradient>
        <linearGradient id="mpWater" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#2e77a8"/><stop offset="1" stop-color="#1c5480"/>
        </linearGradient>
        <clipPath id="mpMarkerClip"><circle r="${MARKER_R - 1}" cx="0" cy="0"/></clipPath>
      </defs>
      <rect x="0" y="0" width="${BASE.w}" height="${BASE.h}" fill="url(#mpLand)"/>
      ${terrainSVG()}
      ${zoneLabels}`;
  }
  /* ---------- 自绘杭州各地貌形状 ---------- */
  function terrainSVG() {
    let s = "";
    // 西部山林：一排绿色山峰
    s += `<g opacity="0.95">`;
    for (let i = 0; i < 6; i++) {
      const bx = 30 + (i % 2) * 70, by = 130 + i * 65;
      const c = i % 2 ? "#1c6b4a" : "#175f42";
      s += `<path d="M${bx} ${by + 70} L${bx + 55} ${by - 10} L${bx + 110} ${by + 70} Z" fill="${c}"/>`;
      s += `<path d="M${bx + 40} ${by + 70} L${bx + 95} ${by + 5} L${bx + 150} ${by + 70} Z" fill="${i % 2 ? '#175f42' : '#1c6b4a'}" opacity="0.85"/>`;
    }
    s += `</g>`;
    // 西溪湿地：带水塘斑块的湿地
    s += `<rect x="248" y="66" width="228" height="185" rx="26" fill="#12564a" opacity="0.7"/>`;
    for (let i = 0; i < 6; i++) {
      const wx = 270 + (i % 3) * 62, wy = 96 + Math.floor(i / 3) * 70;
      s += `<ellipse cx="${wx}" cy="${wy}" rx="26" ry="17" fill="url(#mpWater)" opacity="0.9"/>`;
    }
    // 西湖：中心大湖 + 苏堤/白堤 + 孤山
    s += `<ellipse cx="527" cy="368" rx="108" ry="98" fill="url(#mpWater)"/>`;
    s += `<line x1="440" y1="330" x2="610" y2="340" stroke="#7fd8be" stroke-width="4" opacity="0.75"/>`;
    s += `<line x1="500" y1="288" x2="520" y2="452" stroke="#7fd8be" stroke-width="4" opacity="0.75"/>`;
    s += `<circle cx="497" cy="330" r="10" fill="#1c6b4a"/>`;
    // 龙井茶园：一排排茶垄
    s += `<rect x="372" y="476" width="205" height="138" rx="20" fill="#2d5a2f" opacity="0.75"/>`;
    for (let i = 0; i < 5; i++) {
      s += `<path d="M382 ${498 + i * 22} q95 -14 185 0" stroke="#4e8f3f" stroke-width="6" fill="none" opacity="0.8"/>`;
    }
    // 城区：楼块
    s += `<rect x="642" y="176" width="272" height="258" rx="18" fill="#20342f" opacity="0.85"/>`;
    for (let i = 0; i < 18; i++) {
      const gx = 664 + (i % 6) * 40, gy = 210 + Math.floor(i / 6) * 66;
      const bh = 24 + (hash("b" + i) % 34);
      s += `<rect x="${gx}" y="${gy - bh + 40}" width="26" height="${bh}" rx="3" fill="#3a5750" opacity="0.9"/>`;
    }
    // 农田稻区：棋盘格田块
    for (let i = 0; i < 12; i++) {
      const fx = 662 + (i % 6) * 47, fy = 74 + Math.floor(i / 6) * 44;
      s += `<rect x="${fx}" y="${fy}" width="42" height="40" rx="4" fill="${i % 2 ? '#3f6a2e' : '#4c7d38'}" opacity="0.85"/>`;
    }
    // 钱塘江：横贯右下的宽江
    s += `<path d="M545 486 Q690 452 800 508 T985 512 L985 662 L545 662 Z" fill="url(#mpWater)"/>`;
    s += `<path d="M560 520 Q700 494 820 542" stroke="#bfe6ff" stroke-width="3" fill="none" opacity="0.5"/>`;
    return s;
  }

  /*__APPEND_MAP2__*/

  /* ================= 渲染与交互 ================= */
  let built = false;
  let svg = null, gMarkers = null, wrap = null;
  const markerEls = {};                 // id -> <g>
  let vb = { x: 0, y: 0, w: BASE.w, h: BASE.h };

  const el = (tag, attrs) => {
    const n = document.createElementNS(SVGNS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };
  const collected = () =>
    (window.HZGame && window.HZGame.collectedIds && window.HZGame.collectedIds()) || [];

  // 标记大小随缩放做反向补偿，保持屏幕上视觉大小基本恒定
  function markerScale() { return vb.w / BASE.w; }

  function applyViewBox() {
    if (!svg) return;
    svg.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    const k = markerScale();
    for (const id in markerEls) {
      const g = markerEls[id];
      g.setAttribute("transform", `translate(${g._x} ${g._y}) scale(${k})`);
    }
  }

  function clampView() {
    vb.w = Math.min(BASE.w, Math.max(BASE.w / MAX_SCALE, vb.w));
    vb.h = vb.w * (BASE.h / BASE.w);
    vb.x = Math.min(BASE.x + BASE.w - vb.w, Math.max(BASE.x, vb.x));
    vb.y = Math.min(BASE.y + BASE.h - vb.h, Math.max(BASE.y, vb.y));
  }

  // 客户端像素 → 逻辑坐标
  function toSvg(clientX, clientY) {
    const r = svg.getBoundingClientRect();
    return {
      x: vb.x + (clientX - r.left) / r.width * vb.w,
      y: vb.y + (clientY - r.top) / r.height * vb.h
    };
  }
  /*__APPEND_MAP3__*/

  /* ---------- 构建单个物种标记 ---------- */
  function buildMarker(sp) {
    const g = el("g", { class: "mp-marker", "data-id": sp.id, tabindex: "0",
      role: "button", "aria-label": "野外样本" });
    g._x = sp._mx; g._y = sp._my;
    const kindCls = sp.kind === "animal" ? "is-animal" : "is-plant";
    g.classList.add(kindCls);

    const ring = el("circle", { class: "mp-ring", r: MARKER_R, cx: 0, cy: 0,
      fill: sp.color || "#7fd8be" });
    // emoji 兜底（图片加载失败时显示）
    const emoji = el("text", { class: "mp-emoji", x: 0, y: 1,
      "text-anchor": "middle", "dominant-baseline": "central" });
    emoji.textContent = sp.emoji || "❔";
    // 缩略图（裁成圆形），依次尝试本地→远程→检索兜底
    const img = el("image", { class: "mp-img", x: -(MARKER_R - 1), y: -(MARKER_R - 1),
      width: (MARKER_R - 1) * 2, height: (MARKER_R - 1) * 2,
      "clip-path": "url(#mpMarkerClip)", preserveAspectRatio: "xMidYMid slice" });
    const urls = (window.AIEngine && AIEngine.imageUrlsFor)
      ? AIEngine.imageUrlsFor(sp) : [];
    let ui = 0;
    const tryNext = () => {
      if (ui >= urls.length) { img.style.display = "none"; return; }
      img.setAttributeNS("http://www.w3.org/1999/xlink", "href", urls[ui]);
      img.setAttribute("href", urls[ui]); ui++;
    };
    img.addEventListener("error", tryNext);
    tryNext();

    const check = el("text", { class: "mp-check", x: MARKER_R - 3, y: -(MARKER_R - 6),
      "text-anchor": "middle" });
    check.textContent = "✓";
    const title = el("title", {});

    g.appendChild(ring); g.appendChild(emoji); g.appendChild(img);
    g.appendChild(check); g.appendChild(title);
    markerEls[sp.id] = g;
    g._species = sp; g._titleEl = title;
    activateMarker(g);
    return g;
  }

  // 点击/回车进入答题；拖拽时不误触
  function activateMarker(g) {
    const fire = () => {
      if (dragMoved) return;
      if (window.HZGame && window.HZGame.startChallenge) {
        window.HZGame.startChallenge(g._species);
      }
    };
    g.addEventListener("click", fire);
    g.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fire(); }
    });
  }
  /*__APPEND_MAP4__*/

  /* ---------- 收录状态刷新（✓ 与名字，未收录不泄露答案） ---------- */
  function refreshCollected() {
    const owned = collected();
    for (const id in markerEls) {
      const g = markerEls[id], sp = g._species;
      const isOwned = owned.indexOf(id) >= 0;
      g.classList.toggle("owned", isOwned);
      const kindTxt = sp.kind === "animal" ? "动物" : "植物";
      g._titleEl.textContent = isOwned
        ? `${sp.name}（${sp.latin}）`
        : `未识别样本 · ${kindTxt}`;
    }
    const c = document.getElementById("mapProgressText");
    if (c) c.textContent = `已收录 ${owned.length} / ${Object.keys(markerEls).length}`;
  }

  /* ---------- 缩放 / 平移 ---------- */
  let dragging = false, dragMoved = false, lastX = 0, lastY = 0;

  function onWheel(e) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 0.85 : 1 / 0.85;   // 上滚放大
    const p = toSvg(e.clientX, e.clientY);
    const newW = Math.min(BASE.w, Math.max(BASE.w / MAX_SCALE, vb.w * factor));
    const ratio = newW / vb.w;
    vb.x = p.x - (p.x - vb.x) * ratio;
    vb.y = p.y - (p.y - vb.y) * ratio;
    vb.w = newW; vb.h = newW * (BASE.h / BASE.w);
    clampView(); applyViewBox();
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    dragging = true; dragMoved = false;
    lastX = e.clientX; lastY = e.clientY;
    wrap.classList.add("grabbing");
    // 不在此处 setPointerCapture：捕获会把 click 事件重定向到画布，导致点标记无法进入答题；
    // pointermove/up 已绑在 window 上，拖拽期间指针移出 SVG 也不丢事件。
  }
  function onPointerMove(e) {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 3) dragMoved = true;
    const r = svg.getBoundingClientRect();
    vb.x -= dx / r.width * vb.w;
    vb.y -= dy / r.height * vb.h;
    lastX = e.clientX; lastY = e.clientY;
    clampView(); applyViewBox();
  }
  function onPointerUp() { dragging = false; wrap.classList.remove("grabbing"); }

  function panByKey(e) {
    const step = vb.w * 0.08;
    if (e.key === "ArrowLeft") vb.x -= step;
    else if (e.key === "ArrowRight") vb.x += step;
    else if (e.key === "ArrowUp") vb.y -= step;
    else if (e.key === "ArrowDown") vb.y += step;
    else return;
    e.preventDefault(); clampView(); applyViewBox();
  }
  function zoomStep(factor) {
    const cx = vb.x + vb.w / 2, cy = vb.y + vb.h / 2;
    const newW = Math.min(BASE.w, Math.max(BASE.w / MAX_SCALE, vb.w * factor));
    vb.x = cx - newW / 2; vb.y = cy - (newW * (BASE.h / BASE.w)) / 2;
    vb.w = newW; vb.h = newW * (BASE.h / BASE.w);
    clampView(); applyViewBox();
  }
  function resetView() {
    vb = { x: 0, y: 0, w: BASE.w, h: BASE.h };
    applyViewBox();
  }
  /*__APPEND_MAP5__*/

  /* ---------- 首次构建 ---------- */
  function build() {
    wrap = document.getElementById("mapCanvas");
    if (!wrap) return;
    const list = layout((window.SPECIES || []).slice());

    svg = el("svg", { class: "mp-svg", viewBox: `0 0 ${BASE.w} ${BASE.h}`,
      preserveAspectRatio: "xMidYMid meet" });
    // 底图
    const bg = el("g", {});
    bg.innerHTML = backgroundSVG();
    svg.appendChild(bg);
    // 标记层
    gMarkers = el("g", { class: "mp-markers" });
    list.forEach((sp) => gMarkers.appendChild(buildMarker(sp)));
    svg.appendChild(gMarkers);
    wrap.appendChild(svg);

    // 交互绑定
    svg.addEventListener("wheel", onWheel, { passive: false });
    svg.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    const zi = document.getElementById("mapZoomIn");
    const zo = document.getElementById("mapZoomOut");
    const rv = document.getElementById("mapReset");
    if (zi) zi.onclick = () => zoomStep(0.8);
    if (zo) zo.onclick = () => zoomStep(1 / 0.8);
    if (rv) rv.onclick = resetView;

    built = true;
    applyViewBox();
    refreshCollected();
  }

  // 方向键仅在地图屏可见时生效
  window.addEventListener("keydown", (e) => {
    const scr = document.getElementById("screen-map");
    if (!built || !scr || !scr.classList.contains("active")) return;
    if (document.querySelector(".modal.show")) return;   // 有弹窗时不抢方向键
    panByKey(e);
  });

  /* ---------- 对外接口 ---------- */
  window.HZMap = {
    render() {                 // 进入地图屏时调用：首次构建，之后仅刷新收录态
      if (!built) build(); else refreshCollected();
    },
    refresh() { if (built) refreshCollected(); },
    resetView
  };
})();
