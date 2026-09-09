// 本地 ARM 管理面 mock (端口 9997):
// 校验 Bearer 令牌, 对常见 ARM 资源返回 canned 响应, 其余路径回显请求内容。
// 用法: node mock-arm.js &  并在 .dev.vars 中设置 ARM_BASE_URL=http://localhost:9997
const http = require("http");

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const u = new URL(req.url, "http://localhost");
      const auth = req.headers["authorization"] || "";
      const send = (obj, status = 200) => {
        const buf = Buffer.from(JSON.stringify(obj));
        res.writeHead(status, {
          "Content-Type": "application/json",
          "Content-Length": buf.length,
        });
        res.end(buf);
      };

      if (!auth.startsWith("Bearer mock-token")) {
        return send(
          { error: { code: "InvalidAuthenticationToken", message: "mock: bad bearer token" } },
          401
        );
      }

      const p = u.pathname;
      if (p === "/subscriptions") {
        return send({
          value: [{ subscriptionId: "sub-001", displayName: "Sub One", state: "Enabled" }],
        });
      }
      if (/\/resourcegroups$/.test(p)) {
        return send({ value: [{ name: "rg-ai", location: "eastus" }] });
      }
      if (/\/listKeys$/.test(p)) {
        return send({ key1: "armkey1-abc123", key2: "armkey2-def456" });
      }
      if (/\/deployments$/.test(p)) {
        return send({
          value: [
            {
              name: "gpt4o-deploy",
              properties: {
                model: { name: "gpt-4o", version: "2024-08-06" },
                provisioningState: "Succeeded",
              },
            },
          ],
        });
      }
      if (/\/models$/.test(p)) {
        return send({ value: [{ name: "gpt-4o", version: "2024-08-06", kind: "OpenAI" }] });
      }
      if (/Microsoft\.CognitiveServices\/accounts$/.test(p)) {
        return send({
          value: [
            {
              name: "aoai-1",
              location: "eastus",
              kind: "OpenAI",
              properties: {
                endpoint: "https://aoai-1.openai.azure.com",
                provisioningState: "Succeeded",
              },
            },
          ],
        });
      }
      // 其余路径: 回显请求 (用于通用透传矩阵验证)
      return send({
        echo: {
          method: req.method,
          path: p,
          apiVersion: u.searchParams.get("api-version"),
          query: Object.fromEntries(u.searchParams.entries()),
          authScheme: auth.split(" ")[0],
          tokenSuffix: auth.slice(-6),
          body,
        },
      });
    });
  })
  .listen(9997, () => console.log("mock arm listening on 9997"));
