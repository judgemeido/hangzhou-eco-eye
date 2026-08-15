/**
 * 本地静态服务器（用于本地预览火眼金睛）
 * 用法：node tools/serve.mjs  然后浏览器打开 http://localhost:8765/
 *
 * 附带 /ai-proxy 同源转发：浏览器直连第三方大模型接口通常被 CORS 拦截，
 * 前端改为请求本地同源的 /ai-proxy?url=<编码后的真实接口地址>，由本进程
 * 服务端转发到真实接口并回传，从而绕开浏览器 CORS 限制。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8765;
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".svg": "image/svg+xml", ".ico": "image/x-icon"
};

/* 逐跳/敏感头，转发时剔除 */
const DROP_HEADERS = new Set([
  "host", "origin", "referer", "connection", "content-length",
  "accept-encoding", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-dest"
]);

function handleProxy(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    });
    return res.end();
  }
  const target = new URL(req.url, "http://x").searchParams.get("url");
  if (!target || !/^https?:\/\//i.test(target)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "bad target url" }));
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const body = Buffer.concat(chunks);
    const fwd = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!DROP_HEADERS.has(k.toLowerCase())) fwd[k] = v;
    }
    try {
      const up = await fetch(target, {
        method: req.method,
        headers: fwd,
        body: (req.method === "GET" || req.method === "HEAD") ? undefined : body
      });
      const buf = Buffer.from(await up.arrayBuffer());
      res.writeHead(up.status, {
        "Content-Type": up.headers.get("content-type") || "application/json",
        "Access-Control-Allow-Origin": "*"
      });
      res.end(buf);
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: String((e && e.message) || e) }));
    }
  });
}

http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (pathname === "/ai-proxy") return handleProxy(req, res);

  let rel = pathname;
  if (rel === "/") rel = "/index.html";
  // 防止路径穿越
  const filePath = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
    res.end(buf);
  });
}).listen(PORT, () => console.log("火眼金睛 running at http://localhost:" + PORT + "/"));
