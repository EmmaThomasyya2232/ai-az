// 本地 Azure 数据面 mock (端口 9999, 阶段三增强):
//  - POST /openai/deployments/:dep/chat/completions
//      stream=true  -> SSE: 角色增量帧 + 末帧 usage + [DONE]
//      stream=false -> OpenAI JSON (含 usage)
//  - 其余路径回显请求 (embeddings 等也带 usage)
// 用法: node mock-server.js &  并在 .dev.vars 中把节点 endpoint 指向 http://localhost:9999
const http = require("http");
const fs = require("fs");
const LOG = __dirname + "/mock-requests.log";

function usage() {
  return { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 };
}

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const echo = {
        path: req.url,
        apiKey: req.headers["api-key"] || null,
        contentType: req.headers["content-type"] || null,
        body,
      };
      fs.appendFileSync(LOG, JSON.stringify(echo) + "\n");

      // SSE 流式 chat
      if (/\/chat\/completions/.test(req.url) && /"stream"\s*:\s*true/.test(body)) {
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

      // OpenAI JSON (chat/completions 与 embeddings 等都带 usage)
      const id = "cmpl-mock-" + Date.now();
      const obj = {
        id,
        object: "list-like",
        model: "mock",
        choices: [{ message: { role: "assistant", content: "Hello from mock" } }],
        usage: usage(),
        echo,
      };
      const buf = Buffer.from(JSON.stringify(obj));
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": buf.length });
      res.end(buf);
    });
  })
  .listen(9999, () => console.log("mock upstream listening on 9999"));

