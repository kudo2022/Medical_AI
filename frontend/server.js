const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ROOT_DIR = path.resolve(__dirname);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  const urlPath = (req.url || "/").split("?")[0];
  const requestedFile = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const safePath = path.normalize(requestedFile).replace(/^(\.\.[/\\])+/, "");
  const fullPath = path.resolve(ROOT_DIR, safePath);

  if (fullPath !== ROOT_DIR && !fullPath.startsWith(ROOT_DIR + path.sep)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n  MedStudy AI Frontend đang chạy tại:`);
  console.log(`  - http://localhost:${PORT}`);
  console.log(`  - http://127.0.0.1:${PORT}\n`);
});
