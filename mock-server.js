const http = require("http");
const fs = require("fs");
const LOG = __dirname + "/mock-requests.log";
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
      const buf = Buffer.from(JSON.stringify(echo));
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": buf.length });
      res.end(buf);
    });
  })
  .listen(9999, () => console.log("mock upstream listening on 9999"));
