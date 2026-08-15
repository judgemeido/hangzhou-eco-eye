/**
 * AI 识别引擎
 * ==================================================================
 * 两套实现共用对外接口：
 *
 *   1) 内置引擎（默认）—— 播放一段「正在识别」的动画流程，再返回一个
 *      （可指定或随机的）物种结果，随开随用、无需联网。
 *
 *   2) 大模型引擎 —— 通过 Ctrl+8「开放接口」自定义供应商接入：
 *      填写供应商地址(Base URL)、API 格式、API 地址(端点)、API Key、
 *      模型列表、上下文长度，即可调用真实多模态大模型进行识别 / 校验。
 * ==================================================================
 */

/* ---------- 网络图片检索（“在网络上搜索图片”）---------- */
function searchWebImage(query) {
  const q = (query || "nature").trim();
  const tags = encodeURIComponent(q.replace(/\s+/g, ","));
  const key = encodeURIComponent(q);
  return [
    `https://loremflickr.com/600/400/${tags}`,
    `https://source.unsplash.com/featured/600x400/?${key}`,
    `https://picsum.photos/seed/${key}/600/400`
  ];
}

/**
 * 返回某物种可用的图片 URL 列表（按优先级）：本地图 → 维基出处 → 关键词检索。
 */
function imageUrlsFor(sp) {
  const id = sp && sp.id;
  const urls = [];
  const local = (window.SPECIES_IMAGES || {})[id];
  const remote = (window.SPECIES_IMAGES_REMOTE || {})[id];
  if (local) urls.push(local);
  if (remote) urls.push(remote);
  return urls.concat(searchWebImage(sp && sp.query));
}

/* ---------- 识别流程文案 ---------- */
const SCAN_STEPS = [
  "初始化视觉神经网络…",
  "定位主体轮廓 · 提取特征点…",
  "比对杭州生态物种特征库…",
  "计算类别置信度分布…",
  "生成生态档案…"
];
/* 闯关模式：额外一步「核验玩家判定」 */
const CHALLENGE_STEPS = [
  "锁定样本 · 初始化视觉神经网络…",
  "提取轮廓 / 纹理 / 色彩特征…",
  "比对杭州生态物种特征库…",
  "计算类别置信度分布…",
  "核验你的判定结果…"
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowMs = () => (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();

/* ================= 1) 内置引擎（默认） ================= */
const MockAI = {
  async recognize(opts = {}) {
    const { forceId, onStep } = opts;
    const steps = opts.steps || SCAN_STEPS;
    for (let i = 0; i < steps.length; i++) {
      onStep && onStep(i, steps[i], (i + 1) / steps.length);
      await sleep(420 + Math.random() * 300);
    }
    const pool = window.SPECIES;
    const species = forceId
      ? pool.find((s) => s.id === forceId)
      : pool[Math.floor(Math.random() * pool.length)];
    const confidence = 0.90 + Math.random() * 0.095;
    const others = pool
      .filter((s) => s.id !== species.id && s.kind === species.kind)
      .sort(() => Math.random() - 0.5).slice(0, 2)
      .map((s) => ({ name: s.name, p: Math.random() * (1 - confidence) }));
    return { species, confidence, alternatives: others, engine: "mock" };
  }
};
/* ================= 2) 大模型引擎（开放接口） ================= */
/* 快速模板：新增供应商时可一键预填 供应商地址 / API 格式 / API 地址 / 模型 */
const PROVIDER_TEMPLATES = [
  { name: "自定义",   format: "openai",    baseUrl: "", path: "/chat/completions", models: [] },
  { name: "智谱 GLM", format: "openai",    baseUrl: "https://open.bigmodel.cn/api/paas/v4", path: "/chat/completions", models: ["glm-4v", "glm-4.5v"] },
  { name: "OpenAI",   format: "openai",    baseUrl: "https://api.openai.com/v1", path: "/chat/completions", models: ["gpt-4o", "gpt-4o-mini"] },
  { name: "Anthropic",format: "anthropic", baseUrl: "https://api.anthropic.com", path: "/v1/messages", models: ["claude-3-5-sonnet-latest"] },
  { name: "通义千问", format: "openai",    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", path: "/chat/completions", models: ["qwen-vl-max"] },
  { name: "Gemini",   format: "gemini",    baseUrl: "https://generativelanguage.googleapis.com/v1beta", path: "/models", models: ["gemini-1.5-flash", "gemini-1.5-pro"] }
];
const DEFAULT_CONTEXT = 200000;
const FORMAT_LABELS = { openai: "OpenAI 兼容", anthropic: "Anthropic", gemini: "Gemini" };
/* 各 API 格式对应的默认端点：切换格式时用来自动同步「API 地址（端点）」 */
const FORMAT_DEFAULT_PATH = { openai: "/chat/completions", anthropic: "/v1/messages", gemini: "/models" };

/* ---------- 配置：加载 / 保存 / 迁移 ---------- */
const AI_CFG_KEY = "hz-eco-eye-ai";
const AI_CFG_VERSION = 6;   // 版本升级时，旧配置会被内置默认覆盖一次
/* 内置默认：预置一个开放接口供应商并设为当前模型（OpenAI 接口模式） */
const BUILTIN_DEFAULT = {
  version: AI_CFG_VERSION,
  activeKey: "hcnsec::MiniMax-M3",
  providers: [{
    id: "hcnsec",
    name: "HCNSec",
    format: "openai",
    baseUrl: "https://api.hcnsec.cn/v1",
    path: "/chat/completions",
    apiKey: "",   // 出于安全考虑不内置密钥：请在设置（Ctrl+8）中填入你自己的 API Key
    contextTokens: DEFAULT_CONTEXT,
    models: ["MiniMax-M3"]
  }]
};
function loadAIConfig() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(AI_CFG_KEY)); } catch (e) {}
  // 仅当已是当前版本的用户配置时才沿用；否则（无配置 / 旧版本）落回内置默认
  if (raw && Array.isArray(raw.providers) && raw.version === AI_CFG_VERSION) {
    return { version: AI_CFG_VERSION, activeKey: raw.activeKey || "default", providers: raw.providers };
  }
  return JSON.parse(JSON.stringify(BUILTIN_DEFAULT));
}
function saveAIConfig(cfg) {
  const out = { version: AI_CFG_VERSION, activeKey: cfg.activeKey || "default", providers: cfg.providers || [] };
  localStorage.setItem(AI_CFG_KEY, JSON.stringify(out));
}

/* 展开所有 (供应商, 模型) 为可选条目 */
function allModels() {
  const out = [];
  (window.AI_CONFIG.providers || []).forEach((p) => {
    (p.models || []).forEach((mdl) => out.push({
      key: p.id + "::" + mdl, providerId: p.id, providerName: p.name || "供应商",
      model: mdl, format: p.format || "openai", baseUrl: p.baseUrl || "",
      path: p.path || "", apiKey: p.apiKey || "", contextTokens: p.contextTokens || DEFAULT_CONTEXT
    }));
  });
  return out;
}
function resolveActive() {
  const key = window.AI_CONFIG.activeKey;
  if (!key || key === "default") return null;
  return allModels().find((m) => m.key === key) || null;
}
function isReal() { return !!resolveActive(); }
function activeLabel() {
  const m = resolveActive();
  return m ? (m.providerName + " · " + m.model) : "默认引擎";
}
/* ---------- 请求构造（按 API 格式）---------- */
function fullUrl(desc) {
  const base = (desc.baseUrl || "").replace(/\/+$/, "");
  let path = desc.path || "";
  if (path && !path.startsWith("/")) path = "/" + path;
  if (desc.format === "gemini") {
    return base + path + "/" + encodeURIComponent(desc.model) +
      ":generateContent?key=" + encodeURIComponent(desc.apiKey || "");
  }
  return base + path;
}
/* 浏览器直连第三方接口常被 CORS 拦截；经同源本地代理（tools/serve.mjs 的
 * /ai-proxy）转发即可绕开。以 http(s) 打开页面时走代理，file:// 场景直连。 */
const AI_PROXY_PATH = "/ai-proxy";
function requestUrl(desc) {
  const target = fullUrl(desc);
  if (typeof location !== "undefined" && /^https?:$/.test(location.protocol)) {
    return AI_PROXY_PATH + "?url=" + encodeURIComponent(target);
  }
  return target;
}
function jsonFromText(text) {
  const s = String(text || "");
  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  return JSON.parse(i >= 0 && j >= i ? s.slice(i, j + 1) : s);
}
function extractText(desc, data) {
  if (desc.format === "anthropic")
    return data && data.content && data.content[0] && data.content[0].text;
  if (desc.format === "gemini")
    return data && data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text;
  return data && data.choices && data.choices[0] && data.choices[0].message &&
    data.choices[0].message.content;
}
/* 构造带图片的视觉识别请求 */
function buildVisionRequest(desc, dataUrl, prompt) {
  const url = requestUrl(desc);
  if (desc.format === "anthropic") {
    const b64 = (dataUrl.split(",")[1]) || "";
    return { url, init: { method: "POST", headers: {
      "Content-Type": "application/json", "x-api-key": desc.apiKey,
      "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true"
    }, body: JSON.stringify({ model: desc.model, max_tokens: 1024, messages: [{ role: "user", content: [
      { type: "text", text: prompt },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } }
    ] }] }) } };
  }
  if (desc.format === "gemini") {
    const b64 = (dataUrl.split(",")[1]) || "";
    return { url, init: { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [
        { text: prompt }, { inline_data: { mime_type: "image/jpeg", data: b64 } }
      ] }] }) } };
  }
  return { url, init: { method: "POST", headers: {
    "Content-Type": "application/json", "Authorization": "Bearer " + desc.apiKey
  }, body: JSON.stringify({ model: desc.model, max_tokens: 1024, stream: false, messages: [{ role: "user", content: [
    { type: "text", text: prompt },
    { type: "image_url", image_url: { url: dataUrl } }
  ] }] }) } };
}
/* 构造极简文本连通性测试请求 */
function buildPingRequest(desc) {
  const url = requestUrl(desc);
  if (desc.format === "anthropic") {
    return { url, init: { method: "POST", headers: {
      "Content-Type": "application/json", "x-api-key": desc.apiKey,
      "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true"
    }, body: JSON.stringify({ model: desc.model, max_tokens: 16,
      messages: [{ role: "user", content: "回复：OK" }] }) } };
  }
  if (desc.format === "gemini") {
    return { url, init: { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: "回复：OK" }] }] }) } };
  }
  return { url, init: { method: "POST", headers: {
    "Content-Type": "application/json", "Authorization": "Bearer " + desc.apiKey
  }, body: JSON.stringify({ model: desc.model, max_tokens: 16, stream: false,
    messages: [{ role: "user", content: "回复：OK" }] }) } };
}
const VISION_PROMPT =
  "识别图中的杭州本地动物或植物，只返回一个 JSON 对象，字段：" +
  "name(中文名), latin(拉丁学名), kind('animal'或'plant'), confidence(0~1), " +
  "habitat, description, facts(字符串数组), alternatives(数组,每项{name,p})。只输出 JSON。";
/* 闯关参考校验用的精简提示：只要 4 个字段，输出极短，响应更快 */
const BRIEF_VISION_PROMPT =
  "识别图中的动物或植物，只输出一个 JSON 对象，不要任何解释或多余文字：" +
  '{"name":"中文名","latin":"拉丁学名","kind":"animal或plant","confidence":0到1之间的数字}';

/* 同源取本地图并转 base64 dataURL（供应商无法直接访问 localhost 资源） */
async function imageDataUrlFor(sp) {
  const urls = imageUrlsFor(sp);
  for (const u of urls) {
    try {
      const resp = await fetch(u, { cache: "force-cache" });
      if (!resp.ok) continue;
      const blob = await resp.blob();
      return await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result); r.onerror = rej;
        r.readAsDataURL(blob);
      });
    } catch (e) {}
  }
  return null;
}

/* 大模型识别：返回结论 + 元数据；失败抛错（由上层静默处理）
 * brief=true 走精简提示（闯关校验只需 name/latin/kind/confidence，响应更快） */
async function aiIdentify({ imageDataUrl, brief }) {
  const desc = resolveActive();
  if (!desc) throw new Error("no-engine");
  if (!imageDataUrl) throw new Error("no-image");
  const t0 = nowMs();
  const prompt = brief ? BRIEF_VISION_PROMPT : VISION_PROMPT;
  const { url, init } = buildVisionRequest(desc, imageDataUrl, prompt);
  // 第三方聚合接口偶发 429/5xx（限流/过载），做少量退避重试
  let resp;
  for (let attempt = 0; ; attempt++) {
    resp = await fetch(url, init);
    if (resp.ok || attempt >= 2 || ![429, 500, 502, 503, 504].includes(resp.status)) break;
    await sleep(700 + attempt * 600);
  }
  const ms = Math.round(nowMs() - t0);
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  const data = await resp.json();
  const text = extractText(desc, data);
  const raw = jsonFromText(text);
  const matched = window.SPECIES.find((sp) => raw.name && raw.name.includes(sp.name)) || null;
  return {
    ok: true, ms, provider: desc.providerName, model: desc.model,
    name: raw.name || "", latin: raw.latin || "", kind: raw.kind || "",
    confidence: (typeof raw.confidence === "number") ? raw.confidence : null,
    matchedId: matched ? matched.id : null,
    rawText: String(text || "").slice(0, 600)
  };
}

/* 连通性测试：极简文本请求，成功返回 {ok, ms, reply}；失败抛错 */
async function testConnection(desc) {
  if (!desc || !desc.baseUrl) throw new Error("no-baseurl");
  if (!desc.model) throw new Error("no-model");
  const t0 = nowMs();
  const { url, init } = buildPingRequest(desc);
  const resp = await fetch(url, init);
  const ms = Math.round(nowMs() - t0);
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  const data = await resp.json();
  return { ok: true, ms, reply: String(extractText(desc, data) || "").slice(0, 120) };
}

/* ================= 上传/通用识别（真实引擎） ================= */
const RealAI = {
  async recognize(opts = {}) {
    const { onStep, imageDataUrl } = opts;
    const steps = opts.steps || SCAN_STEPS;
    onStep && onStep(0, "上传图像至大模型…", 0.3);
    const r = await aiIdentify({ imageDataUrl });
    onStep && onStep(steps.length - 1, "解析模型返回 · 生成档案…", 0.95);
    const matched = r.matchedId ? window.SPECIES.find((s) => s.id === r.matchedId) : null;
    return {
      species: matched || {
        id: "unknown", name: r.name || "未知物种", latin: r.latin || "",
        kind: r.kind || "animal", emoji: "🔍", color: "#8fa0ff",
        habitat: "—", status: "识别结果", rarity: 2,
        desc: "识别到的物种，暂未收录进本地生态档案库。", facts: [], query: r.name || "nature"
      },
      confidence: (r.confidence != null) ? r.confidence : 0.9,
      alternatives: [], engine: "real", aiCheck: r
    };
  }
};
/* ---------- 统一出口 ---------- */
window.AI_CONFIG = loadAIConfig();
window.AI_ENGINE = isReal() ? "real" : "mock";   // 仅内部标记，不对用户展示

window.AIEngine = {
  searchWebImage, imageUrlsFor, SCAN_STEPS, CHALLENGE_STEPS,
  TEMPLATES: PROVIDER_TEMPLATES, DEFAULT_CONTEXT, FORMAT_LABELS, FORMAT_DEFAULT_PATH,
  getConfig: () => window.AI_CONFIG,
  isReal, activeLabel,
  imageDataUrlFor, aiIdentify, testConnection,
  // 应用一份新配置（来自设置界面），持久化并刷新引擎标记
  applyConfig(cfg) {
    window.AI_CONFIG = {
      version: AI_CFG_VERSION,
      activeKey: (cfg && cfg.activeKey) || "default",
      providers: (cfg && cfg.providers) || []
    };
    saveAIConfig(window.AI_CONFIG);
    window.AI_ENGINE = isReal() ? "real" : "mock";
    return window.AI_CONFIG;
  },
  // 仅走内置引擎（闯关的物种揭示始终用真实样本，不受大模型影响）
  recognizeLocal(opts) { return MockAI.recognize(opts); },
  // 上传/通用识别：真实引擎失败时静默回退内置引擎
  async recognize(opts) {
    if (isReal()) {
      try { return await RealAI.recognize(opts); }
      catch (e) { return MockAI.recognize(opts); }
    }
    return MockAI.recognize(opts);
  }
};
