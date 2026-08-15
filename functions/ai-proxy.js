/**
 * Cloudflare Pages Function —— 路由到 /ai-proxy
 *
 * 作用等价于本地 tools/serve.mjs 里的 /ai-proxy：把浏览器发来的请求
 * 同源转发到第三方大模型接口，绕开「接口不返回 CORS 头」导致的跨域拦截。
 * 部署到 Cloudflare Pages 时，本文件会自动对外提供 https://<你的域名>/ai-proxy。
 *
 * 安全：公开站点上的转发端点若允许任意 url 会变成开放代理（可被滥用 / SSRF），
 * 因此这里用 ALLOW_HOSTS 白名单限制只能转发到已知的大模型接口域名。
 * 如需接入其它供应商，把它的域名加进 ALLOW_HOSTS 即可。
 */
const ALLOW_HOSTS = new Set([
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

// 转发前需要剔除的逐跳 / 会误导上游的请求头
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

export async function onRequest(context) {
  const { request } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const target = new URL(request.url).searchParams.get("url");
  if (!target || !/^https:\/\//i.test(target)) {
    return json(400, { error: "bad target url" });
  }

  let t;
  try { t = new URL(target); } catch (e) { return json(400, { error: "bad target url" }); }
  if (!ALLOW_HOSTS.has(t.hostname)) {
    return json(403, { error: "host not allowed" });
  }

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
