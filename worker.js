/**
 * Cloudflare Worker 入口（Workers + Static Assets 模式）
 *
 * - /ai-proxy ：同源转发到第三方大模型接口，绕开「接口不返回 CORS 头」的跨域拦截
 *   （等价于本地 tools/serve.mjs 的 /ai-proxy）。
 * - 其余请求：交给静态资源绑定 env.ASSETS（即托管的游戏页面/js/图片等）。
 *
 * 安全：公开站点上的转发端点若允许任意 url 会变成开放代理（可被滥用 / SSRF），
 * 因此用 ALLOW_HOSTS 白名单限制只能转发到已知大模型接口域名；接其它供应商就加进来。
 */
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

  let t;
  try { t = new URL(target); } catch (e) { return json(400, { error: "bad target url" }); }
  if (!ALLOW_HOSTS.has(t.hostname)) return json(403, { error: "host not allowed" });

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
