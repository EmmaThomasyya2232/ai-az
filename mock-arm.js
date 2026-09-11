// 本地 ARM 管理面 mock (端口 9997):
// 校验 Bearer 令牌, 对常见 ARM 资源返回 canned 响应, 其余路径回显请求内容。
// 阶段六扩展: policyAssignments / quotaTiers / usages / resourcegroup 试探 / listKeys。
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
          value: [
            { subscriptionId: "sub-001", displayName: "Sub One", state: "Enabled" },
            { subscriptionId: "sub-002", displayName: "Sub Two", state: "Enabled" },
          ],
        });
      }
      // 资源组试探: 被禁区域的请求返回策略错误 (含 allowed locations)
      if (/\/resourcegroups\/[^/]+$/.test(p) && req.method === "PUT") {
        const location = (() => {
          try {
            return JSON.parse(body).location ?? "";
          } catch {
            return "";
          }
        })();
        if (["centralus", "eastus", "germanywestcentral", "swedencentral", "francecentral"].includes(location)) {
          return send({ name: "rg-probe-ok", location, properties: { provisioningState: "Succeeded" } });
        }
        if (location === "westus") {
          return send(
            {
              error: {
                code: "RequestDisallowedByAzure",
                message:
                  "The current subscription type is not permitted to create resources in this region. Allowed locations: 'centralus, eastus'",
              },
            },
            403
          );
        }
        return send({ error: { code: "LocationNotAvailableForResourceType", message: "mock: unavailable" } }, 400);
      }
      if (/\/resourcegroups(\?|$)/.test(p)) {
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
      if (/Microsoft\.CognitiveServices\/accounts\/[^/]+\/deployments\/[^/]+$/.test(p) && req.method === "PUT") {
        // 部署创建: 接受任意请求, 返回 201
        return send({ name: p.split("/").pop(), properties: { provisioningState: "Succeeded" } }, 201);
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
      if (/Microsoft\.CognitiveServices\/accounts\/[^/]+$/.test(p) && req.method === "PUT") {
        // 模拟学生订阅资源类型级区域限制: 仅 germanywestcentral 可建 CognitiveServices
        const loc = (() => {
          try {
            return JSON.parse(body).location ?? "";
          } catch {
            return "";
          }
        })();
        if (loc !== "germanywestcentral") {
          return send(
            {
              error: {
                code: "RequestDisallowedByAzure",
                message:
                  `Operation could not be completed as it results in forbidden approval. ` +
                  `The subscription does not allow creating this resource in location '${loc}'. ` +
                  `Allowed locations: germanywestcentral`,
              },
            },
            403
          );
        }
        return send({
          name: "azmgrwu-xxxx",
          kind: "AIServices",
          sku: { name: "S0", tier: "Standard" },
          // 指向本地数据面 mock, 便于端到端验证
          properties: { endpoint: "http://localhost:9999", provisioningState: "Succeeded" },
        });
      }
      if (/Microsoft\.CognitiveServices\/accounts\/[^/]+$/.test(p)) {
        return send({
          name: "azmgrwu-xxxx",
          kind: "AIServices",
          sku: { name: "S0", tier: "Standard" },
          properties: { endpoint: "http://localhost:9999", provisioningState: "Succeeded" },
        });
      }
      if (/Microsoft\.CognitiveServices\/quotaTiers\/default$/.test(p)) {
        // 真实 Azure 结构: 字段嵌在 properties 里
        return send({
          properties: {
            currentTierName: "Free Tier",
            assignedTime: "2026-01-01T00:00:00Z",
            tierUpgradePolicy: { grace: "30d" },
            upgradeUnavailabilityReason: null,
          },
        });
      }
      if (/locat(ion|ions)\/[^/]+\/usages$/.test(p)) {
        return send({
          value: [
            { name: { value: "Text Token TPM" }, currentValue: 10, limit: 240000, unit: "Count" },
            { name: { value: "Requests Per Minute" }, currentValue: 3, limit: 1000, unit: "Count" },
          ],
        });
      }
      // 订阅级可用区域 (学生订阅受限: 仅少数区域)
      if (/^\/subscriptions\/[^/]+\/locations$/.test(p)) {
        return send({
          value: [
            { name: "germanywestcentral", displayName: "Germany West Central", regionalDisplayName: "(Europe) Germany West Central" },
            { name: "swedencentral", displayName: "Sweden Central", regionalDisplayName: "(Europe) Sweden Central" },
            { name: "francecentral", displayName: "France Central", regionalDisplayName: "(Europe) France Central" },
          ],
        });
      }
      if (/policyAssignments/.test(p)) {
        // 真实学生订阅通常没有 allowed-locations 策略 -> 走订阅 /locations 探测
        return send({ value: [] });
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
