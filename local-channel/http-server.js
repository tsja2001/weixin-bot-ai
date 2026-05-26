// local-channel/http-server.js — Node 原生 HTTP 服务器
import http from "http";
import { buildMsgFromText, buildMsgFromFile, buildMsgFromImage, buildMsgFromRaw, enqueue } from "./inbox.js";
import { getEventsSince, waitForEvents, reset, getNextSeq } from "./outbox.js";

export function createServer({ port, snapshotForProbe, resetUser }) {
  const server = http.createServer((req, res) => {
    req.on("error", () => {});
    res.on("error", () => {});
    handleRequest(req, res, { port, snapshotForProbe, resetUser });
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`[LOCAL] HTTP 服务已启动: http://127.0.0.1:${port}`);
  });

  return server;
}

async function handleRequest(req, res, { port, snapshotForProbe, resetUser }) {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const path = url.pathname;

  try {
    if (req.method === "GET" && path === "/local/health") {
      return json(res, 200, { ok: true, instance_dir: process.cwd() });
    }

    if (req.method === "GET" && path === "/local/outbox") {
      const since = parseInt(url.searchParams.get("since") || "0", 10);
      const waitMs = parseInt(url.searchParams.get("wait_ms") || "0", 10);
      if (waitMs > 0) {
        const events = await waitForEvents({ since, timeout_ms: Math.min(waitMs, 60000) });
        return json(res, 200, { events, next_seq: getNextSeq() });
      }
      const events = getEventsSince(since);
      return json(res, 200, { events, next_seq: getNextSeq() });
    }

    if (req.method === "GET" && path === "/local/state") {
      const user_id = url.searchParams.get("user_id") || "local:default";
      const snapshot = snapshotForProbe(user_id);
      return json(res, 200, snapshot);
    }

    if (req.method === "POST" && path === "/local/inbox/text") {
      const body = await readBody(req);
      if (!body.text) return json(res, 400, { error: "缺少 text 字段" });
      const user_id = body.user_id || "local:default";
      if (!user_id.startsWith("local:")) return json(res, 400, { error: "user_id 必须以 local: 开头" });
      const msg = buildMsgFromText({ user_id, text: body.text });
      enqueue(msg);
      console.log(`[LOCAL 入站] text → ${user_id}: ${body.text.slice(0, 80)}`);
      return json(res, 200, { ok: true, message_id: msg.message_id });
    }

    if (req.method === "POST" && path === "/local/inbox/file") {
      const body = await readBody(req);
      if (!body.file_path) return json(res, 400, { error: "缺少 file_path 字段" });
      const user_id = body.user_id || "local:default";
      if (!user_id.startsWith("local:")) return json(res, 400, { error: "user_id 必须以 local: 开头" });
      try {
        const msg = buildMsgFromFile({ user_id, file_path: body.file_path, file_name: body.file_name });
        enqueue(msg);
        console.log(`[LOCAL 入站] file → ${user_id}: ${msg.item_list[0].file_item.file_name}`);
        return json(res, 200, { ok: true, message_id: msg.message_id, file_name: msg.item_list[0].file_item.file_name });
      } catch (e) {
        return json(res, 400, { error: `文件不可读: ${e.message}` });
      }
    }

    if (req.method === "POST" && path === "/local/inbox/image") {
      const body = await readBody(req);
      if (!body.file_path) return json(res, 400, { error: "缺少 file_path 字段" });
      const user_id = body.user_id || "local:default";
      if (!user_id.startsWith("local:")) return json(res, 400, { error: "user_id 必须以 local: 开头" });
      try {
        const msg = buildMsgFromImage({ user_id, file_path: body.file_path });
        enqueue(msg);
        console.log(`[LOCAL 入站] image → ${user_id}: ${body.file_path}`);
        return json(res, 200, { ok: true, message_id: msg.message_id });
      } catch (e) {
        return json(res, 400, { error: `图片不可读: ${e.message}` });
      }
    }

    if (req.method === "POST" && path === "/local/inbox/raw") {
      const body = await readBody(req);
      if (!body.msg) return json(res, 400, { error: "缺少 msg 字段" });
      const msg = buildMsgFromRaw({ msg: body.msg });
      enqueue(msg);
      console.log(`[LOCAL 入站] raw → ${msg.from_user_id}`);
      return json(res, 200, { ok: true, message_id: msg.message_id });
    }

    if (req.method === "POST" && path === "/local/reset") {
      const body = await readBody(req).catch(() => ({}));
      const user_id = body.user_id || null;
      if (user_id && resetUser) resetUser(user_id);
      reset(user_id);
      console.log(`[LOCAL] reset ${user_id || "all"}`);
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: "未知端点" });
  } catch (e) {
    console.log(`[LOCAL HTTP] 错误: ${e.message}`);
    if (!res.headersSent) {
      return json(res, 500, { error: e.message });
    }
  }
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => { data += chunk; });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(new Error("JSON 解析失败: " + e.message)); }
    });
    req.on("error", reject);
  });
}
