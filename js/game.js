/* ================= 火眼金睛 · 游戏主逻辑 ================= */
(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  /* -------- 持久化状态（生态积分 + 已收录物种） -------- */
  const SAVE_KEY = "hz-eco-eye-save";
  const INIT_SCORE = 100;                    // 初始 / 重置后的生态积分
  const state = loadState();

  function loadState() {
    try {
      const s = JSON.parse(localStorage.getItem(SAVE_KEY));
      if (s && Array.isArray(s.collected)) return s;
    } catch (e) {}
    return { score: INIT_SCORE, collected: [] };   // 默认赠送 100 生态积分
  }
  function saveState() { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); }

  // 重置存档：清空收录、积分回到初始 100（原地修改 const 对象）
  function resetState() {
    state.score = INIT_SCORE;
    state.collected.length = 0;
    saveState();
    refreshHUD();
  }

  /* -------- HUD -------- */
  function refreshHUD() {
    $("#scoreVal").textContent = state.score;
    $("#collectedVal").textContent = state.collected.length;
    $("#totalVal").textContent = SPECIES.length;
    const pct = SPECIES.length ? (state.collected.length / SPECIES.length) * 100 : 0;
    $("#homeProgress").style.width = pct + "%";
    $("#homeProgressText").textContent =
      `收录进度 ${state.collected.length} / ${SPECIES.length}`;
  }

  /* -------- 舞台导航 -------- */
  function show(screen) {
    // 离开答题页（除进入识别动画外）一律作废本关，避免残留计时器误判超时
    if (screen !== "quiz" && screen !== "scan") abandonQuiz();
    $$(".screen").forEach((s) => s.classList.remove("active"));
    $("#screen-" + screen).classList.add("active");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* -------- Toast -------- */
  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
  }

  /* -------- 图片加载：带兜底 -------- */
  // 依次尝试候选 URL，全失败则回调 fail（用 emoji 兜底）
  function loadImageWithFallback(imgEl, urls, onOk, onFail) {
    let i = 0;
    imgEl.style.display = "none";
    function tryNext() {
      if (i >= urls.length) { onFail && onFail(); return; }
      const url = urls[i++];
      imgEl.onload = () => { imgEl.style.display = "block"; onOk && onOk(); };
      imgEl.onerror = tryNext;
      imgEl.src = url;
    }
    tryNext();
  }

  /* -------- 背景粒子（萤火 / 数据点） -------- */
  function initBackground() {
    const cv = $("#bg"), ctx = cv.getContext("2d");
    let W, H, dots;
    function resize() {
      W = cv.width = innerWidth; H = cv.height = innerHeight;
      dots = Array.from({ length: Math.min(70, Math.floor(W / 22)) }, () => ({
        x: Math.random() * W, y: Math.random() * H,
        r: Math.random() * 2 + 0.6,
        vx: (Math.random() - 0.5) * 0.3, vy: (Math.random() - 0.5) * 0.3,
        a: Math.random() * 0.6 + 0.2
      }));
    }
    function tick() {
      ctx.clearRect(0, 0, W, H);
      for (const d of dots) {
        d.x += d.vx; d.y += d.vy;
        if (d.x < 0 || d.x > W) d.vx *= -1;
        if (d.y < 0 || d.y > H) d.vy *= -1;
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(95, 242, 192, ${d.a})`;
        ctx.fill();
      }
      requestAnimationFrame(tick);
    }
    addEventListener("resize", resize); resize(); tick();
  }

  /* -------- 计分规则（集中在此，便于调整） -------- */
  const RULES = {
    TIME_LIMIT: 15,                                  // 闯关限时（秒）
    base: (sp) => 20 + sp.rarity * 15,               // 答对基础分
    newBonus: 60,                                    // 首次收录奖励
    speedBonus: (left) => Math.round(left) * 2,      // 每剩 1 秒 +2
    penalty: (sp) => -(10 + sp.rarity * 5)           // 答错 / 超时扣分
  };

  /* -------- 渲染样本网格 -------- */
  function renderSamples() {
    const grid = $("#sampleGrid");
    grid.innerHTML = "";
    SPECIES.forEach((sp) => {
      const owned = state.collected.includes(sp.id);   // 已识别收录的样本亮明身份
      const card = document.createElement("div");
      card.className = "sample-card" + (owned ? " owned" : "");
      const kindLabel = sp.kind === "animal" ? "🐾 动物" : "🌿 植物";
      const kindCls = sp.kind === "animal" ? "kind-animal" : "kind-plant";
      card.innerHTML = `
        <span class="kind-tag ${kindCls}">${kindLabel}</span>
        <div class="card-thumb" style="background:linear-gradient(135deg, ${sp.color}55, #05221c);">
          <span class="ph">${sp.emoji}</span>
          <img alt="${sp.name}" />
          ${owned ? '<span class="owned-badge">✓ 已收录</span>' : ""}
        </div>
        <div class="card-body">
          <h4>${owned ? sp.name : "? ? ?"}</h4>
          <div class="latin">${owned ? sp.latin : "未识别样本"}</div>
        </div>`;
      const img = card.querySelector("img");
      const ph = card.querySelector(".ph");
      loadImageWithFallback(img, AIEngine.imageUrlsFor(sp),
        () => { ph.style.display = "none"; }, null);
      card.addEventListener("click", () => startChallenge(sp));
      grid.appendChild(card);
    });
  }

  /* -------- 限时闯关：出题 + 15 秒倒计时 -------- */
  let quiz = null; // { sp, timer, done, options }

  // 洗牌（Fisher–Yates）
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // 干扰项优先取同类（动物/植物）物种，不足时再从全库补齐
  function buildOptions(sp) {
    const sameKind = SPECIES.filter((s) => s.id !== sp.id && s.kind === sp.kind);
    const others = SPECIES.filter((s) => s.id !== sp.id && s.kind !== sp.kind);
    const distractors = shuffle(sameKind).slice(0, 3);
    while (distractors.length < 3 && others.length) distractors.push(others.pop());
    return shuffle([sp].concat(distractors));
  }

  function startChallenge(sp) {
    clearQuizTimer();
    quiz = { sp, done: false, options: buildOptions(sp) };

    // 题面图片（本地图 → 远程 → emoji 兜底）
    const img = $("#quizImg"), emoji = $("#quizEmoji");
    emoji.style.display = "flex"; emoji.textContent = sp.emoji;
    loadImageWithFallback(img, AIEngine.imageUrlsFor(sp),
      () => { emoji.style.display = "none"; }, null);

    // 只提示大类，避免直接泄露答案
    $("#quizKind").textContent = sp.kind === "animal" ? "🐾 动物" : "🌿 植物";
    $("#quizStakes").innerHTML =
      `本关赌注：答对 <b>+${RULES.base(sp)}</b> 起（含剩余时间加成，首次收录再 +${RULES.newBonus}）` +
      ` · 答错或超时 <b style="color:var(--danger)">${RULES.penalty(sp)}</b>`;

    // 选项按钮
    const box = $("#quizOptions");
    box.innerHTML = "";
    quiz.options.forEach((opt, i) => {
      const btn = document.createElement("button");
      btn.className = "quiz-opt";
      btn.dataset.id = opt.id;
      btn.innerHTML = `<b><span class="idx">${"ABCD"[i]}</span>${opt.name}</b><i>${opt.latin}</i>`;
      btn.onclick = () => answerQuiz(opt.id, btn);
      box.appendChild(btn);
    });

    show("quiz");
    runQuizTimer();
  }

  function runQuizTimer() {
    const fill = $("#quizTimerFill"), clock = $("#quizClock");
    const q = quiz;                                  // 绑定本关，防止旧计时器影响新一关
    let remain = RULES.TIME_LIMIT;
    fill.style.width = "100%"; fill.classList.remove("warn");
    clock.classList.remove("warn");
    clock.innerHTML = remain.toFixed(1) + "<small>s</small>";

    q.timer = setInterval(() => {
      // 本关已结束 / 已被新一关取代 / 已离开答题页 → 立即停表
      if (quiz !== q || q.done || !$("#screen-quiz").classList.contains("active")) {
        clearInterval(q.timer);
        return;
      }
      remain = Math.max(0, remain - 0.1);
      q.remain = remain;
      fill.style.width = (remain / RULES.TIME_LIMIT) * 100 + "%";
      clock.innerHTML = remain.toFixed(1) + "<small>s</small>";
      if (remain <= 5) { fill.classList.add("warn"); clock.classList.add("warn"); }
      if (remain <= 0) answerQuiz(null, null);   // 超时判负
    }, 100);
    q.remain = remain;
  }

  function clearQuizTimer() { if (quiz && quiz.timer) clearInterval(quiz.timer); }

  // 主动放弃本关：停表并作废，不计分
  function abandonQuiz() {
    if (!quiz || quiz.done) return;
    quiz.done = true;
    clearQuizTimer();
  }

  // 提交答案（id 为 null 表示超时）；无论成败都进入 AI 识别动画
  function answerQuiz(pickedId, btn) {
    if (!quiz || quiz.done) return;
    quiz.done = true;
    clearQuizTimer();

    $$("#quizOptions .quiz-opt").forEach((b) => { b.disabled = true; });
    if (btn) btn.classList.add("picked");

    const sp = quiz.sp;
    const timeout = pickedId === null;
    const correct = !timeout && pickedId === sp.id;
    const used = +(RULES.TIME_LIMIT - (quiz.remain || 0)).toFixed(1);

    // 略作停顿让「已选中」的高亮可见，再进入识别动画
    setTimeout(() => startScan({
      forceId: sp.id,
      challenge: { correct, timeout, pickedId, timeLeft: quiz.remain || 0, used }
    }), 260);
  }

  /* -------- AI 识别动画（闯关核验 / 上传练习都会走完） -------- */
  let currentInput = null; // { forceId, challenge } 或 { imageDataUrl }
  function startScan(input) {
    currentInput = input;
    show("scan");
    const scanImg = $("#scanImg");
    const scanEmoji = $("#scanEmoji");
    const log = $("#scanLog");
    const status = $("#scanStatus");
    const prog = $("#scanProgress");
    log.innerHTML = "";
    status.textContent = input.challenge ? "AI 正在核验你的判定…" : "AI 正在分析…";
    prog.style.width = "0%";

    // 设置扫描框预览图
    if (input.imageDataUrl) {
      scanEmoji.style.display = "none";
      scanImg.style.display = "block"; scanImg.src = input.imageDataUrl;
    } else {
      const sp = SPECIES.find((s) => s.id === input.forceId);
      scanImg.style.display = "none";
      scanEmoji.style.display = "flex"; scanEmoji.textContent = sp ? sp.emoji : "🖼️";
      loadImageWithFallback(scanImg, AIEngine.imageUrlsFor(sp),
        () => { scanEmoji.style.display = "none"; }, null);
    }

    // 闯关：物种揭示始终走内置引擎（真实样本）；上传练习走统一识别（可真实）
    const sp = input.forceId ? SPECIES.find((s) => s.id === input.forceId) : null;
    const recognizePromise = input.challenge
      ? AIEngine.recognizeLocal({
          forceId: input.forceId, steps: AIEngine.CHALLENGE_STEPS,
          onStep: onScanStep
        })
      : AIEngine.recognize({
          imageDataUrl: input.imageDataUrl, steps: AIEngine.SCAN_STEPS,
          onStep: onScanStep
        });

    // 真实引擎 + 闯关：并行把样本图交给大模型做参考校验（成功才用，失败静默）
    let aiCheckPromise = Promise.resolve(null);
    const aiPending = !!(input.challenge && AIEngine.isReal() && sp);
    if (aiPending) {
      const real = AIEngine.imageDataUrlFor(sp)
        .then((durl) => (durl ? AIEngine.aiIdentify({ imageDataUrl: durl, brief: true }) : null))
        .catch(() => null);
      // 上限等待，避免个别接口卡住时结算界面一直不出现
      const timeout = new Promise((r) => setTimeout(() => r(null), 20000));
      aiCheckPromise = Promise.race([real, timeout]);
    }

    function onScanStep(idx, text, p) {
      const items = log.querySelectorAll("li");
      if (items.length) items[items.length - 1].classList.add("done");
      const li = document.createElement("li");
      li.textContent = text; log.appendChild(li);
      prog.style.width = Math.round(p * 100) + "%";
    }

    recognizePromise.then(async (res) => {
      const items = log.querySelectorAll("li");
      if (items.length) items[items.length - 1].classList.add("done");
      const ch = input.challenge;
      const doneText = ch
        ? (ch.correct ? "核验完成 · 判定正确 ✓" : "核验完成 · 判定错误 ✗")
        : "识别完成 ✓";
      status.textContent = doneText;

      // 真实引擎校验：显示可见的「核验中」反馈（成功/失败都不改变本地判定；失败静默移除）
      let liveLi = null;
      if (aiPending) {
        status.textContent = "🛰️ 大模型核验中…";
        prog.style.width = "100%";
        liveLi = document.createElement("li");
        liveLi.className = "ai-live";
        liveLi.textContent = "🛰️ 正在调用大模型核验这张图片…";
        log.appendChild(liveLi);
      }
      const ai = await aiCheckPromise;             // null 表示无/失败
      res.aiCheck = (ai && ai.ok) ? ai : null;
      if (liveLi) {
        if (res.aiCheck) {
          liveLi.classList.add("done");
          liveLi.textContent = "🛰️ 大模型核验完成：" + (res.aiCheck.name || "已返回结论");
        } else {
          liveLi.remove();   // 失败静默：不显示任何错误内容
        }
        status.textContent = doneText;
      }
      setTimeout(() => showResult(res), 620);
    });
  }

  /* -------- 展示识别结果（含闯关成败判定） -------- */
  function showResult(res) {
    const sp = res.species;
    const ch = currentInput && currentInput.challenge;   // 无 challenge 即上传练习模式
    const won = ch ? ch.correct : null;
    const isNew = won === true && !state.collected.includes(sp.id);

    // ---- 结算：答对加分（含速度加成与首次收录奖励），答错/超时扣分 ----
    let delta = 0;
    if (won === true) {
      delta = RULES.base(sp) + RULES.speedBonus(ch.timeLeft) + (isNew ? RULES.newBonus : 0);
      if (isNew) state.collected.push(sp.id);
    } else if (won === false) {
      delta = RULES.penalty(sp);
    }
    state.score = Math.max(0, state.score + delta);      // 积分不小于 0
    saveState(); refreshHUD();

    // ---- 成败横幅 ----
    const picked = ch && ch.pickedId ? SPECIES.find((s) => s.id === ch.pickedId) : null;
    let verdict;
    if (won === true) {
      verdict = `
        <div class="verdict ok">
          <span class="vd-icon">🎯</span>
          <div>
            <h3>闯关成功！识别正确</h3>
            <div class="vd-sub">用时 ${ch.used}s · 剩余 ${ch.timeLeft.toFixed(1)}s（速度加成 +${RULES.speedBonus(ch.timeLeft)}）${isNew ? " · 首次收录 +" + RULES.newBonus : ""}</div>
          </div>
          <div class="vd-delta">+${delta}</div>
        </div>`;
    } else if (won === false) {
      verdict = `
        <div class="verdict bad">
          <span class="vd-icon">${ch.timeout ? "⏱️" : "❌"}</span>
          <div>
            <h3>闯关失败 · ${ch.timeout ? "超时未作答" : "识别错误"}</h3>
            <div class="vd-sub">${ch.timeout
              ? "15 秒内未选择，本次不予收录"
              : `你选择了「${picked ? picked.name : "?"}」，正确答案是「${sp.name}」`}</div>
          </div>
          <div class="vd-delta">${delta}</div>
        </div>`;
    } else {
      verdict = `
        <div class="verdict neutral">
          <span class="vd-icon">🧪</span>
          <div>
            <h3>练习模式 · 已完成识别</h3>
            <div class="vd-sub">上传照片没有标准答案，因此本次不计分。点选样本可进入限时闯关。</div>
          </div>
          <div class="vd-delta">±0</div>
        </div>`;
    }

    const stars = "★".repeat(sp.rarity) + "☆".repeat(5 - sp.rarity);
    const conf = Math.round(res.confidence * 100);
    const altText = (res.alternatives && res.alternatives.length)
      ? "其它候选：" + res.alternatives
          .map((a) => `${a.name} ${(a.p * 100).toFixed(1)}%`).join(" · ")
      : "";

    // 大模型参考校验面板（仅在真实调用成功时出现；失败则完全不渲染）
    const ai = res.aiCheck;
    let aiPanel = "";
    if (ai && ai.ok) {
      const agree = ai.matchedId && sp.id === ai.matchedId;
      const confTxt = (ai.confidence != null) ? ` · 置信度 ${(ai.confidence * 100).toFixed(0)}%` : "";
      aiPanel = `
        <div class="ai-check">
          <div class="ai-head">🛰️ 大模型校验 · ${escHtml(ai.provider)} / ${escHtml(ai.model)} · ${ai.ms}ms</div>
          <div>识别结论：<b>${escHtml(ai.name || "—")}</b>${ai.latin ? ` <i>${escHtml(ai.latin)}</i>` : ""}${confTxt}</div>
          <div>与本关答案「${escHtml(sp.name)}」：${agree
            ? '<b style="color:var(--mint)">一致 ✓</b>'
            : '<b style="color:var(--gold)">存在差异</b>'}</div>
          ${ai.rawText ? `<div class="ai-raw">模型原始返回：${escHtml(ai.rawText)}</div>` : ""}
        </div>`;
    }

    const card = $("#resultCard");
    card.innerHTML = `
      ${verdict}
      <div class="result-hero" style="background:linear-gradient(135deg, ${sp.color}66, #05221c);">
        <span class="emoji-big">${sp.emoji}</span>
        <img id="resultImg" alt="${sp.name}" />
        <div class="veil"></div>
        <div class="conf-badge"><b>${conf}%</b><small>置信度</small></div>
        <div class="result-name">
          <h2>${sp.name}${isNew ? '<span class="new-badge">新收录!</span>' : ""}</h2>
          <div class="latin">${sp.latin || ""}</div>
        </div>
      </div>
      <div class="result-body">
        <div class="meta-row">
          <span class="meta-pill"><b>类别</b> ${sp.kind === "animal" ? "🐾 动物" : "🌿 植物"}</span>
          <span class="meta-pill"><b>栖息地</b> ${sp.habitat}</span>
          <span class="meta-pill"><b>状态</b> ${sp.status}</span>
          <span class="meta-pill"><b>稀有度</b> <span class="stars">${stars}</span></span>
        </div>
        ${aiPanel}
        <p class="desc">${sp.desc}</p>
        <ul class="facts">${(sp.facts || []).map((f) => `<li>${f}</li>`).join("")}</ul>
        ${altText ? `<div class="alt-line">${altText}</div>` : ""}
        <div class="alt-line">生态积分变化 <b style="color:${delta < 0 ? "var(--danger)" : "var(--gold)"}">${delta > 0 ? "+" : ""}${delta}</b> · 当前 ${state.score}</div>
        <div class="result-actions">
          ${won === true ? '<button class="btn primary" id="tagBtn">⚡ 闪电标记 +50</button>' : ""}
          <button class="btn ${won === true ? "ghost" : "primary"}" id="againBtn">🔄 再来一关</button>
          <button class="btn ghost" id="archiveBtn2">📚 查看档案</button>
        </div>
      </div>`;

    // 结果大图
    const img = card.querySelector("#resultImg");
    const emoji = card.querySelector(".emoji-big");
    if (currentInput && currentInput.imageDataUrl) {
      img.style.display = "block"; img.src = currentInput.imageDataUrl;
      emoji.style.display = "none";
    } else {
      loadImageWithFallback(img, AIEngine.imageUrlsFor(sp),
        () => { emoji.style.display = "none"; }, null);
    }

    show("result");
    window.scrollTo({ top: 0, behavior: "auto" });
    if (won === true && isNew) toast(`🎉 新物种「${sp.name}」已录入生态档案！`);
    else if (won === false) toast(ch.timeout ? "⏱️ 超时，扣分！" : "❌ 识别错误，扣分！");

    // 绑定结果页按钮（闪电标记仅在答对时出现）
    const tagBtn = card.querySelector("#tagBtn");
    if (tagBtn) tagBtn.onclick = () => openTagGame(sp);
    card.querySelector("#againBtn").onclick = () => { renderSamples(); show("pick"); };
    card.querySelector("#archiveBtn2").onclick = () => { renderArchive(); show("archive"); };
  }

  /* -------- ⚡ 闪电标记小游戏 -------- */
  let tagState = null;
  function openTagGame(sp) {
    const modal = $("#tagModal");
    $("#tagTarget").textContent = sp.emoji;
    $("#tagTimerFill").style.width = "100%";
    modal.classList.add("show");

    let remain = 3.0;
    const answered = { done: false };
    tagState = { sp, answered };
    const timer = setInterval(() => {
      remain -= 0.1;
      $("#tagTimerFill").style.width = Math.max(0, (remain / 3) * 100) + "%";
      if (remain <= 0) { clearInterval(timer); if (!answered.done) finishTag(null); }
    }, 100);
    tagState.timer = timer;
  }
  function finishTag(kind) {
    if (!tagState || tagState.answered.done) return;
    tagState.answered.done = true;
    clearInterval(tagState.timer);
    $("#tagModal").classList.remove("show");
    if (kind === null) { toast("⏱️ 超时！标记失败。"); return; }
    if (kind === tagState.sp.kind) {
      state.score += 50; saveState(); refreshHUD();
      toast("⚡ 标记正确！+50 生态积分");
    } else {
      toast("❌ 分类错误，再接再厉！");
    }
  }

  /* -------- 数字生态档案 -------- */
  let archiveFilter = "all";
  function renderArchive() {
    const grid = $("#archiveGrid");
    grid.innerHTML = "";
    SPECIES
      .filter((sp) => archiveFilter === "all" || sp.kind === archiveFilter)
      .forEach((sp) => {
        const owned = state.collected.includes(sp.id);
        const card = document.createElement("div");
        card.className = "archive-card sample-card" + (owned ? "" : " locked");
        const kindLabel = sp.kind === "animal" ? "🐾 动物" : "🌿 植物";
        const kindCls = sp.kind === "animal" ? "kind-animal" : "kind-plant";
        card.innerHTML = `
          <span class="kind-tag ${kindCls}">${kindLabel}</span>
          <div class="card-thumb" style="background:linear-gradient(135deg, ${sp.color}55, #05221c);">
            <span class="ph">${owned ? sp.emoji : "❔"}</span>
            <img alt="" />
          </div>
          <div class="card-body">
            <h4>${owned ? sp.name : "未收录"}</h4>
            <div class="latin">${owned ? sp.latin : "继续探索杭州生态…"}</div>
          </div>`;
        if (owned) {
          const img = card.querySelector("img");
          const ph = card.querySelector(".ph");
          loadImageWithFallback(img, AIEngine.imageUrlsFor(sp),
            () => { ph.style.display = "none"; }, null);
          card.addEventListener("click", () => startChallenge(sp));
        }
        grid.appendChild(card);
      });
  }

  // 后续逻辑在此占位继续  /*__APPEND__*/

  /* -------- 上传图片处理 -------- */
  function handleFile(file) {
    if (!file || !file.type.startsWith("image/")) { toast("请选择图片文件"); return; }
    const reader = new FileReader();
    reader.onload = (e) => startScan({ imageDataUrl: e.target.result });
    reader.readAsDataURL(file);
  }

  /* -------- 识别引擎设置（开放接口 · Ctrl+8） -------- */
  let apiDraft = null;
  let providerSeq = 0;
  const genProviderId = () => "p" + Date.now().toString(36) + (providerSeq++);
  const escHtml = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const escAttr = (s) => escHtml(s).replace(/"/g, "&quot;");
  const providerToDesc = (p, model) => ({
    format: p.format, baseUrl: p.baseUrl, path: p.path, apiKey: p.apiKey,
    model: model, contextTokens: p.contextTokens || AIEngine.DEFAULT_CONTEXT,
    providerName: p.name || "供应商"
  });

  function openApiModal() {
    const cfg = AIEngine.getConfig();
    apiDraft = {
      activeKey: cfg.activeKey || "default",
      providers: JSON.parse(JSON.stringify(cfg.providers || []))
    };
    apiDraft.providers.forEach((p) => { if (!p.id) p.id = genProviderId(); });
    renderApiTemplates();
    renderApiEngines();
    $("#apiModal").classList.add("show");
  }
  function closeApiModal() { $("#apiModal").classList.remove("show"); }

  function renderApiTemplates() {
    $("#apiTemplate").innerHTML = AIEngine.TEMPLATES
      .map((t, i) => `<option value="${i}">模板：${t.name}</option>`).join("");
  }

  function renderApiEngines() {
    const box = $("#apiEngineList");
    box.innerHTML = "";
    const def = document.createElement("label");
    def.className = "api-default-row" + (apiDraft.activeKey === "default" ? " active" : "");
    def.innerHTML =
      `<input type="radio" name="apiActive" ${apiDraft.activeKey === "default" ? "checked" : ""}>
       <span class="rlabel"><b>默认引擎</b><small>内置识别 · 无需联网</small></span>`;
    def.querySelector("input").onchange = () => { apiDraft.activeKey = "default"; renderApiEngines(); };
    box.appendChild(def);
    apiDraft.providers.forEach((p) => box.appendChild(buildProviderCard(p)));
  }

  function addProviderFromTemplate() {
    const t = AIEngine.TEMPLATES[parseInt($("#apiTemplate").value, 10)] || AIEngine.TEMPLATES[0];
    apiDraft.providers.push({
      id: genProviderId(), name: t.name === "自定义" ? "" : t.name, format: t.format,
      baseUrl: t.baseUrl, path: t.path, apiKey: "",
      contextTokens: AIEngine.DEFAULT_CONTEXT, models: (t.models || []).slice()
    });
    renderApiEngines();
  }

  function saveApiConfig() {
    AIEngine.applyConfig(apiDraft);
    closeApiModal();
    toast(AIEngine.isReal() ? `已启用「${AIEngine.activeLabel()}」` : "已启用默认引擎");
  }
  function buildProviderCard(p) {
    const card = document.createElement("div");
    card.className = "api-provider";
    const fmtOpts = Object.keys(AIEngine.FORMAT_LABELS)
      .map((f) => `<option value="${f}" ${p.format === f ? "selected" : ""}>${AIEngine.FORMAT_LABELS[f]}</option>`).join("");
    card.innerHTML = `
      <div class="api-prov-head">
        <input class="pname" value="${escAttr(p.name || "")}" placeholder="供应商名称" />
        <button class="api-prov-del" type="button">删除供应商</button>
      </div>
      <div class="api-grid">
        <div class="full"><label>供应商地址（Base URL）</label><input class="pbase" value="${escAttr(p.baseUrl || "")}" placeholder="https://…/v1" /></div>
        <div><label>API 格式</label><select class="pfmt">${fmtOpts}</select></div>
        <div><label>API 地址（端点）</label><input class="ppath" value="${escAttr(p.path || "")}" placeholder="/chat/completions" /></div>
        <div class="full"><label>API Key</label><input class="pkey" type="password" value="${escAttr(p.apiKey || "")}" placeholder="仅存于本机浏览器" autocomplete="off" /></div>
        <div><label>上下文长度</label><input class="pctx" type="number" min="1" value="${p.contextTokens || AIEngine.DEFAULT_CONTEXT}" /></div>
      </div>
      <div class="api-models">
        <label class="sec">模型列表（选中一个作为当前识别引擎）</label>
        <div class="model-rows"></div>
        <div class="api-add-model">
          <input class="new-model" placeholder="输入模型名，如 gpt-4o / glm-4v" />
          <button class="btn-mini add-model" type="button">＋ 添加模型</button>
        </div>
      </div>`;
    card.querySelector(".pname").oninput = (e) => { p.name = e.target.value; };
    card.querySelector(".pbase").oninput = (e) => { p.baseUrl = e.target.value; };
    card.querySelector(".pfmt").onchange = (e) => { p.format = e.target.value; };
    card.querySelector(".ppath").oninput = (e) => { p.path = e.target.value; };
    card.querySelector(".pkey").oninput = (e) => { p.apiKey = e.target.value; };
    card.querySelector(".pctx").oninput = (e) => { p.contextTokens = parseInt(e.target.value, 10) || AIEngine.DEFAULT_CONTEXT; };
    card.querySelector(".api-prov-del").onclick = () => {
      apiDraft.providers = apiDraft.providers.filter((x) => x !== p);
      if (String(apiDraft.activeKey).indexOf(p.id + "::") === 0) apiDraft.activeKey = "default";
      renderApiEngines();
    };
    const rows = card.querySelector(".model-rows");
    (p.models || []).forEach((mdl) => rows.appendChild(buildModelRow(p, mdl)));
    const newInput = card.querySelector(".new-model");
    const addModel = () => {
      const name = newInput.value.trim();
      if (!name) return;
      if (!p.models) p.models = [];
      if (!p.models.includes(name)) p.models.push(name);
      newInput.value = "";
      renderApiEngines();
    };
    card.querySelector(".add-model").onclick = addModel;
    newInput.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); addModel(); } };
    return card;
  }
  function buildModelRow(p, mdl) {
    const key = p.id + "::" + mdl;
    const row = document.createElement("div");
    row.className = "api-model-row" + (apiDraft.activeKey === key ? " active" : "");
    row.innerHTML = `
      <input type="radio" name="apiActive" ${apiDraft.activeKey === key ? "checked" : ""} />
      <span class="mname">${escHtml(mdl)}</span>
      <button class="btn-mini test" type="button">测试</button>
      <button class="m-del" type="button">✕</button>
      <div class="api-test-result"></div>`;
    row.querySelector('input[type=radio]').onchange = () => { apiDraft.activeKey = key; renderApiEngines(); };
    row.querySelector(".m-del").onclick = () => {
      p.models = (p.models || []).filter((x) => x !== mdl);
      if (apiDraft.activeKey === key) apiDraft.activeKey = "default";
      renderApiEngines();
    };
    const resEl = row.querySelector(".api-test-result");
    const testBtn = row.querySelector(".test");
    testBtn.onclick = async () => {
      resEl.textContent = "";                       // 先清空
      testBtn.classList.add("testing"); testBtn.disabled = true;
      testBtn.textContent = "测试中…";
      try {
        const r = await AIEngine.testConnection(providerToDesc(p, mdl));
        resEl.textContent = `✓ 连接成功 · 延迟 ${r.ms}ms` + (r.reply ? " · 返回：" + r.reply : "");
      } catch (e) {
        resEl.textContent = "";                     // 失败静默：不显示任何内容/错误
      } finally {
        testBtn.classList.remove("testing"); testBtn.disabled = false;
        testBtn.textContent = "测试";
      }
    };
    return row;
  }


  /* -------- 事件绑定 & 初始化 -------- */
  function bindEvents() {
    $("#startScanBtn").onclick = () => { renderSamples(); show("pick"); };
    $("#goArchiveBtn").onclick = () => { renderArchive(); show("archive"); };
    // 重置存档：清空收录并把积分恢复为初始 100（弹窗二次确认，避免误清）
    $("#resetBtn").onclick = () => $("#resetModal").classList.add("show");
    $("#resetCancelBtn").onclick = () => $("#resetModal").classList.remove("show");
    $("#resetModal").addEventListener("click", (e) => {
      if (e.target.id === "resetModal") $("#resetModal").classList.remove("show");
    });
    $("#resetConfirmBtn").onclick = () => {
      resetState();
      renderSamples();   // 若样本网格已渲染，同步复位为「未识别」
      $("#resetModal").classList.remove("show");
      toast("♻️ 存档已重置，生态积分恢复为 " + INIT_SCORE);
    };
    // 离开答题页要中止倒计时，避免回到别的页面后仍被判超时
    $$(".back-btn").forEach((b) => (b.onclick = () => {
      abandonQuiz();
      if (b.dataset.to === "pick") renderSamples();
      show(b.dataset.to);
    }));

    // 上传区
    const zone = $("#uploadZone"), input = $("#fileInput");
    zone.onclick = () => input.click();
    input.onchange = (e) => handleFile(e.target.files[0]);
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("drag"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("drag"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault(); zone.classList.remove("drag");
      handleFile(e.dataTransfer.files[0]);
    });

    // 档案筛选
    $$(".chip").forEach((chip) => {
      chip.onclick = () => {
        $$(".chip").forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        archiveFilter = chip.dataset.filter;
        renderArchive();
      };
    });

    // 闪电标记按钮
    $$(".tag-btns .btn").forEach((b) => (b.onclick = () => finishTag(b.dataset.kind)));

    // API 识别引擎设置（Ctrl+8 调出；#设置 哈希亦可，用于快捷键被浏览器占用时）
    $("#apiAddProvider").onclick = addProviderFromTemplate;
    $("#apiSaveBtn").onclick = saveApiConfig;
    $("#apiCancelBtn").onclick = closeApiModal;
    $("#apiModal").addEventListener("click", (e) => {
      if (e.target.id === "apiModal") closeApiModal();   // 点击遮罩关闭
    });
    // 用捕获阶段监听，尽量抢在浏览器默认行为之前处理 Ctrl+8
    window.addEventListener("keydown", (e) => {
      const isCtrl8 = (e.ctrlKey || e.metaKey) && (e.key === "8" || e.code === "Digit8" || e.code === "Numpad8");
      if (isCtrl8) {
        e.preventDefault(); e.stopPropagation();
        $("#apiModal").classList.contains("show") ? closeApiModal() : openApiModal();
      } else if (e.key === "Escape") {
        closeApiModal();
      }
    }, true);
    // 兜底入口：地址栏 #设置 / #settings 可直接打开设置
    const openByHash = () => {
      let h = location.hash || "";
      try { h = decodeURIComponent(h); } catch (e) {}
      if (/#(设置|settings)/i.test(h)) openApiModal();
    };
    window.addEventListener("hashchange", openByHash);
    openByHash();
  }

  function init() {
    initBackground();
    bindEvents();
    refreshHUD();
  }
  document.addEventListener("DOMContentLoaded", init);
})();
