/**
 * Cloudflare Worker 入口（Workers + Static Assets 模式）
 *
 * - /ai-proxy ：同源转发到第三方大模型接口，绕开「接口不返回 CORS 头」的跨域拦截
 *   （等价于本地 tools/serve.mjs 的 /ai-proxy）。
 * - 其余请求：交给静态资源绑定 env.ASSETS（即托管的游戏页面/js/图片等）。
 *
 * ⚠️ 安全提醒：按用户要求已放开域名白名单——任意 https 目标都可经此端点转发，
 *   这实际上是一个「开放代理」，可能被他人滥用（当作免费代理 / SSRF 探测内网等），
 *   会消耗你的 Cloudflare 额度。若要收紧，把下方 ALLOW_HOSTS 检查重新启用即可。
 */
// 已知大模型接口域名（当前不作强制校验，仅作参考/便于日后重新收紧白名单）：
const ALLOW_HOSTS = new Set([
  "myapi.creitingameplays.com",
  "api.ltzy.top",
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "dashscope.aliyuncs.com",
]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const DROP = new Set([
  "host", "origin", "referer", "connection", "content-length",
  "accept-encoding", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-dest",
  "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor",
  "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-real-ip",
]);

function json(status, obj) {
  const headers = new Headers(CORS);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(obj), { status, headers });
}

async function handleProxy(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  const target = new URL(request.url).searchParams.get("url");
  if (!target || !/^https:\/\//i.test(target)) return json(400, { error: "bad target url" });

  try { new URL(target); } catch (e) { return json(400, { error: "bad target url" }); }
  // 白名单已按用户要求放开：任意 https 目标都放行（如需收紧，恢复下面这行）：
  // if (!ALLOW_HOSTS.has(new URL(target).hostname)) return json(403, { error: "host not allowed" });

  const fwd = new Headers();
  for (const [k, v] of request.headers) {
    if (!DROP.has(k.toLowerCase())) fwd.set(k, v);
  }
  const method = request.method;
  const body = (method === "GET" || method === "HEAD") ? undefined : await request.arrayBuffer();

  try {
    const up = await fetch(target, { method, headers: fwd, body });
    const buf = await up.arrayBuffer();
    const headers = new Headers(CORS);
    headers.set("Content-Type", up.headers.get("content-type") || "application/json");
    return new Response(buf, { status: up.status, headers });
  } catch (e) {
    return json(502, { error: String((e && e.message) || e) });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ai-proxy") return handleProxy(request);
    if (env.ASSETS) return env.ASSETS.fetch(request);   // 其余走静态资源
    return new Response("Not found", { status: 404 });
  },
};
