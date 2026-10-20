/**
 * Assembles the landing page for a local look: copies the icon and the README
 * screenshots into site/, substitutes the version badge in memory, and serves
 * the result on a loopback port.
 *
 *   pnpm site
 */
import { createServer } from "node:http";
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const ROOT = resolve("site");
const PORT = Number(process.env["SITE_PORT"] ?? 4173);

mkdirSync(join(ROOT, "assets"), { recursive: true });
mkdirSync(join(ROOT, "screenshots"), { recursive: true });
copyFileSync("build/icon.png", join(ROOT, "assets", "icon.png"));
for (const file of readdirSync("docs/screenshots")) {
  if (file.endsWith(".png")) {
    copyFileSync(join("docs/screenshots", file), join(ROOT, "screenshots", file));
  }
}

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
// Substitute while serving: writing the result back would erase the placeholder
// the Pages workflow depends on.
const html = readFileSync(join(ROOT, "index.html"), "utf8").replaceAll("__VERSION__", version);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/" || url.pathname === "/index.html") {
    response.writeHead(200, { "content-type": TYPES[".html"] });
    response.end(html);
    return;
  }
  const target = resolve(ROOT, url.pathname.slice(1));
  // Never serve outside site/, even if a crafted path tries to climb out.
  if (!target.startsWith(ROOT)) {
    response.writeHead(403).end("forbidden");
    return;
  }
  try {
    const body = readFileSync(target);
    response.writeHead(200, {
      "content-type": TYPES[extname(target)] ?? "application/octet-stream",
    });
    response.end(body);
  } catch {
    response.writeHead(404).end("not found");
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`assembled site for ${version}`);
  console.log(`preview: http://127.0.0.1:${PORT}/`);
});
