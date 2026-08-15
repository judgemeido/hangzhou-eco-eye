/**
 * 图片本地化助手（一次性工具）
 * ------------------------------------------------------------------
 * 背景：本机 shell / node 无外网（TLS 连接被重置），只有浏览器可访问外网。
 * 因此由浏览器负责下载 + 压缩图片，再回传给本服务写入磁盘。
 *
 * 用法：
 *   node tools/fetch-images.mjs
 *   然后浏览器打开 http://localhost:8799/
 *
 * 产物：assets/img/<物种id>.jpg（最长边 800px，JPEG q0.82）
 * ------------------------------------------------------------------
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "assets", "img");
const PORT = 8799;

fs.mkdirSync(OUT_DIR, { recursive: true });

/** 从 js/images.js 里解析出 id → 远程 URL 映射 */
function readRemoteMap() {
  const src = fs.readFileSync(path.join(ROOT, "js", "images.js"), "utf8");
  const map = {};
  const re = /^\s*([A-Za-z_][\w]*)\s*:\s*"([^"]+)"/gm;
  let m;
  while ((m = re.exec(src))) map[m[1]] = m[2];
  return map;
}

const PAGE = fs.readFileSync(path.join(ROOT, "tools", "downloader.html"), "utf8");

http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(PAGE);
  }

  if (req.method === "GET" && url.pathname === "/list.json") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify(readRemoteMap()));
  }

  if (req.method === "POST" && url.pathname === "/save") {
    // 文件名只允许 [a-z0-9_-]，避免路径穿越
    const name = String(url.searchParams.get("name") || "");
    if (!/^[a-z0-9_-]+$/i.test(name)) {
      res.writeHead(400); return res.end("bad name");
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const b64 = Buffer.concat(chunks).toString("utf8").replace(/^data:[^,]+,/, "");
      const buf = Buffer.from(b64, "base64");
      fs.writeFileSync(path.join(OUT_DIR, name + ".jpg"), buf);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok " + buf.length);
    });
    return;
  }

  res.writeHead(404); res.end("not found");
}).listen(PORT, () => {
  console.log("fetch-images helper on http://localhost:" + PORT + "  -> " + OUT_DIR);
});
