import { createServer } from "node:http";

// Recovery-only container: never import or initialize the original application,
// database, Discord bot, or encryption key.
const port = Number(process.env.PORT) || 8080;
createServer((req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, mode: "recovery" }));
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}).listen(port, "0.0.0.0");
