// 本地 Azure 数据面 mock (端口 9999, 阶段五增强):
//  - GET  /openai/models        -> 模型列表 (Cron 巡检探活)
//  - POST /openai/deployments/:dep/chat/completions
//        stream=true -> SSE / stream=false -> JSON (含 usage)
//  - POST /__mock/fail?times=3&status=429   故障注入 (chat 与 models 同时生效)
//  - POST /__mock/reset                     清除注入
//  - POST /__webhook                        接收并记录告警 webhook; GET /__webhook/last 查看
// 用法: node mock-server.js &  并在 .dev.vars 中把节点 endpoint 指向 http://localhost:9999
const http = require("http");
const fs = require("fs");
const LOG = __dirname + "/mock-requests.log";

let failTimes = 0;
let failStatus = 429;
let lastWebhook = null;

function usage() {
  return { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 };
}
function json(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": buf.length });
  res.end(buf);
}
function maybeFail(res) {
  if (failTimes > 0) {
    failTimes--;
    json(res, failStatus, {
      error: { message: `mock injected failure (HTTP ${failStatus})`, code: failStatus },
    });
    return true; // 注意: json() 返回 undefined, 必须显式 return true
  }
  return false;
}

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const u = new URL(req.url, "http://localhost");

      // ---- 测试控制端点 ----
      if (u.pathname === "/__mock/fail") {
        failTimes = Math.max(0, Number(u.searchParams.get("times") ?? "1"));
        failStatus = Number(u.searchParams.get("status") ?? "429");
        return json(res, 200, { ok: true, failTimes, failStatus });
      }
      if (u.pathname === "/__mock/reset") {
        failTimes = 0;
        return json(res, 200, { ok: true });
      }
      if (u.pathname === "/__webhook") {
        lastWebhook = { ts: new Date().toISOString(), body };
        return json(res, 200, { ok: true });
      }
      if (u.pathname === "/__webhook/last") {
        return json(res, 200, lastWebhook ?? { ts: null, body: null });
      }

      fs.appendFileSync(LOG, JSON.stringify({ path: req.url, apiKey: req.headers["api-key"] || null, body }) + "\n");

      // ---- 巡检探活 (受故障注入影响) ----
      if (req.method === "GET" && /\/openai\/models$/.test(u.pathname)) {
        if (maybeFail(res)) return;
        return json(res, 200, {
          object: "list",
          data: [{ id: "gpt-4o-deploy", object: "model", owned_by: "mock" }],
        });
      }

      // ---- chat/completions ----
      if (/\/chat\/completions/.test(u.pathname)) {
        if (maybeFail(res)) return;
        if (/"stream"\s*:\s*true/.test(body)) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          const id = "chatcmpl-mock-" + Date.now();
          const frame = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
          frame({ id, object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] });
          frame({ id, object: "chat.completion.chunk", choices: [{ delta: { content: "Hello" } }] });
          frame({ id, object: "chat.completion.chunk", choices: [{ delta: { content: " from mock" } }] });
          frame({ id, object: "chat.completion.chunk", choices: [], usage: usage() });
          res.write("data: [DONE]\n\n");
          return res.end();
        }
        return json(res, 200, {
          id: "cmpl-mock-" + Date.now(),
          object: "list-like",
          model: "mock",
          choices: [{ message: { role: "assistant", content: "Hello from mock" } }],
          usage: usage(),
        });
      }

      // ---- 其余路径: 回显 ----
      return json(res, 200, {
        id: "cmpl-mock-" + Date.now(),
        object: "list-like",
        model: "mock",
        usage: usage(),
        echo: { path: req.url, apiKey: req.headers["api-key"] || null, body },
      });
    });
  })
  .listen(9999, () => console.log("mock upstream listening on 9999"));


