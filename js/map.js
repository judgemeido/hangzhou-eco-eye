/**
 * 杭州生态地图（v2.0 · 真实地图）
 * ==================================================================
 * 基于 Leaflet + 高德(AutoNavi)栅格瓦片，把 60 个物种（30 动物 + 30 植物）
 * 按栖息地落在真实的杭州经纬度上：滚轮缩放、左键拖拽、方向键 ↑↓←→ 平移，
 * 另有 ➕ ➖ 与「重置视图」。点击某个物种标记 → 进入原有的 15 秒限时识别
 * 答题流程（复用 window.HZGame.startChallenge，答题/计分/AI 校验逻辑不变）。
 *
 * 坐标说明：高德瓦片为 GCJ-02 坐标系，故下方物种坐标直接以 GCJ-02 给出，
 * 与瓦片天然对齐、无需纠偏；Leaflet 由本地 assets/vendor/leaflet 载入。
 * ------------------------------------------------------------------
 */
(function () {
  "use strict";

  const HZ_CENTER = [30.2360, 120.1300];      // 视野中心（GCJ-02）
  const DEFAULT_ZOOM = 12;
  const MIN_ZOOM = 10, MAX_ZOOM = 18;
  // 拖动边界：限制在杭州主城 + 周边
  const HZ_MAX_BOUNDS = [[30.02, 119.80], [30.45, 120.55]];

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

  /* ---------- 分区：真实杭州地标中心（GCJ-02）+ 散布半径（度） ---------- */
  const ZONES = {
    xihu:     { c: [30.2470, 120.1470], r: 0.017, label: "西湖" },
    xixi:     { c: [30.2700, 120.0820], r: 0.022, label: "西溪湿地" },
    tea:      { c: [30.2270, 120.1150], r: 0.015, label: "龙井茶园" },
    mountain: { c: [30.2000, 120.0620], r: 0.030, label: "西部山林" },
    urban:    { c: [30.2830, 120.1650], r: 0.026, label: "城区" },
    farm:     { c: [30.3080, 120.2250], r: 0.024, label: "农田稻区" },
    qiantang: { c: [30.2050, 120.2020], r: 0.028, label: "钱塘江" }
  };

  /* ---------- 物种 → 分区（栖息地关键词匹配） ---------- */
  function zoneFor(sp) {
    const h = sp.habitat || "";
    const has = (kws) => kws.some((k) => h.indexOf(k) >= 0);
    if (has(["钱塘江", "入海", "河口", "江滩", "洄游"])) return "qiantang";
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
    if (has(["荷塘", "池塘", "静水", "湖荡", "水景", "溪", "水岸", "河荡", "河道", "湿"])) {
      return (hash(sp.id) % 2 === 0) ? "xihu" : "xixi";
    }
    return "urban";
  }

  /* ---------- 分区内确定性散布（均匀圆盘） ---------- */
  function place(sp, zone) {
    const a = rand01(sp.id + "@a") * Math.PI * 2;
    const d = zone.r * Math.sqrt(rand01(sp.id + "@d"));
    const lat = zone.c[0] + d * Math.cos(a);
    const lng = zone.c[1] + d * Math.sin(a) / Math.cos(zone.c[0] * Math.PI / 180);
    return [lat, lng];
  }
  function layout(list) {
    list.forEach((sp) => {
      const zid = zoneFor(sp);
      sp._zone = zid;
      sp._ll = place(sp, ZONES[zid]);
    });
    return list;
  }

  /* ================= 渲染与交互 ================= */
  let built = false, map = null, wrap = null;
  const markers = {};   // id -> { marker, sp }

  const collected = () =>
    (window.HZGame && window.HZGame.collectedIds && window.HZGame.collectedIds()) || [];

  // 单个标记的 DOM：圆形缩略图（加载失败回退 emoji），已收录显示 ✓
  function iconHtml(sp) {
    const urls = (window.AIEngine && AIEngine.imageUrlsFor) ? AIEngine.imageUrlsFor(sp) : [];
    const first = urls[0] || "";
    const rest = urls.slice(1).join("|");
    const kind = sp.kind === "animal" ? "is-animal" : "is-plant";
    const img = first
      ? `<img class="mp-pin-img" src="${first}" data-rest="${rest}" alt=""
             onerror="window.HZMap&&HZMap._imgErr(this)"/>`
      : "";
    return `<div class="mp-pin ${kind}" data-id="${sp.id}">
        <div class="mp-pin-face">
          <span class="mp-pin-emoji">${sp.emoji || "❔"}</span>${img}
        </div>
        <span class="mp-pin-check">✓</span>
      </div>`;
  }

  /* ---------- 收录状态刷新（✓ 与名字，未收录不泄露答案） ---------- */
  function refreshCollected() {
    const owned = collected();
    Object.keys(markers).forEach((id) => {
      const { marker, sp } = markers[id];
      const isOwned = owned.indexOf(id) >= 0;
      const iconEl = marker.getElement && marker.getElement();
      const pin = iconEl ? iconEl.querySelector(".mp-pin") : null;
      if (!pin) return;
      pin.classList.toggle("owned", isOwned);
      const kindTxt = sp.kind === "animal" ? "动物" : "植物";
      pin.setAttribute("title", isOwned
        ? `${sp.name}（${sp.latin}）`
        : `未识别样本 · ${kindTxt}`);
    });
    const c = document.getElementById("mapProgressText");
    if (c) c.textContent = `已收录 ${owned.length} / ${Object.keys(markers).length}`;
  }

  /* ---------- 首次构建 ---------- */
  function build() {
    wrap = document.getElementById("mapCanvas");
    if (!wrap || !window.L) return;
    map = L.map(wrap, {
      center: HZ_CENTER, zoom: DEFAULT_ZOOM,
      minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM,
      zoomControl: false, maxBounds: HZ_MAX_BOUNDS, maxBoundsViscosity: 0.6,
      scrollWheelZoom: true, dragging: true, keyboard: true
    });
    L.tileLayer(
      "https://wprd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scl=1&style=7&x={x}&y={y}&z={z}",
      { subdomains: ["1", "2", "3", "4"], minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM,
        attribution: "地图 © 高德地图" }
    ).addTo(map);

    layout((window.SPECIES || []).slice()).forEach((sp) => {
      const m = L.marker(sp._ll, {
        icon: L.divIcon({ className: "mp-divicon", html: iconHtml(sp),
          iconSize: [42, 42], iconAnchor: [21, 21] }),
        keyboard: false, riseOnHover: true
      });
      m.on("click", () => {
        if (window.HZGame && HZGame.startChallenge) HZGame.startChallenge(sp);
      });
      m.addTo(map);
      markers[sp.id] = { marker: m, sp };
    });

    const zi = document.getElementById("mapZoomIn");
    const zo = document.getElementById("mapZoomOut");
    const rv = document.getElementById("mapReset");
    if (zi) zi.onclick = () => map.zoomIn();
    if (zo) zo.onclick = () => map.zoomOut();
    if (rv) rv.onclick = resetView;

    built = true;
    refreshCollected();
  }
  function resetView() { if (map) map.setView(HZ_CENTER, DEFAULT_ZOOM); }

  // 方向键平移：仅在地图屏可见、无弹窗时生效
  window.addEventListener("keydown", (e) => {
    const scr = document.getElementById("screen-map");
    if (!map || !scr || !scr.classList.contains("active")) return;
    if (document.querySelector(".modal.show")) return;
    const step = 90;
    let dx = 0, dy = 0;
    if (e.key === "ArrowLeft") dx = -step;
    else if (e.key === "ArrowRight") dx = step;
    else if (e.key === "ArrowUp") dy = -step;
    else if (e.key === "ArrowDown") dy = step;
    else return;
    e.preventDefault();
    map.panBy([dx, dy]);
  });

  /* ---------- 对外接口 ---------- */
  window.HZMap = {
    render() {                 // 进入地图屏：首次构建，之后仅刷新收录态
      if (!built) build(); else refreshCollected();
      // Leaflet 需要容器有尺寸后校正：地图屏刚显示时补一次尺寸刷新
      if (map) {
        requestAnimationFrame(() => map.invalidateSize());
        setTimeout(() => { if (map) map.invalidateSize(); }, 80);
      }
    },
    refresh() { if (built) refreshCollected(); },
    resetView,
    // 缩略图逐个回退：换下一个候选 URL，全部失败则移除（露出 emoji 兜底）
    _imgErr(img) {
      const rest = (img.getAttribute("data-rest") || "").split("|").filter(Boolean);
      if (rest.length) {
        img.src = rest.shift();
        img.setAttribute("data-rest", rest.join("|"));
      } else {
        img.remove();
      }
    }
  };
})();
