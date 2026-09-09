// Entra ID token 端点的本地 mock (端口 9998):
// 返回带调用计数的 access_token (mock-token-1, mock-token-2 ...), 便于验证三层缓存命中层数。
// 用法: node mock-aad.js &  并在 .dev.vars 中设置 AAD_AUTHORITY=http://localhost:9998
const http = require("http");
let calls = 0;
http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const params = new URLSearchParams(body);
      calls++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          token_type: "Bearer",
          expires_in: 3600,
          access_token: `mock-token-${calls}`,
          received: {
            path: req.url,
            tenant: (req.url.split("/")[1] || "").split("/")[0],
            grant_type: params.get("grant_type"),
            client_id: params.get("client_id"),
            scope: params.get("scope"),
          },
        })
      );
    });
  })
  .listen(9998, () => console.log("mock aad listening on 9998"));
