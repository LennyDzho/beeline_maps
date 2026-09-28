import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedWorker } from "./isolated-worker.mjs";

/** Browser-only test host; ephemeral port, loopback only, in-memory DB.
 * No option exists to point this host at the user's server or database.
 */
export async function startBrowserServer() {
  const app = await isolatedWorker();
  const clientRoot = fileURLToPath(new URL("../../dist/client/", import.meta.url));
  const mime = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json",
    ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon" };
  const server = createServer(async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url, origin);
      const local = resolve(clientRoot, `.${decodeURIComponent(url.pathname)}`);
      if (local.startsWith(resolve(clientRoot) + sep) && !url.pathname.includes("..") && mime[extname(local)]) {
        try {
          const content = await readFile(local);
          outgoing.writeHead(200, { "content-type": mime[extname(local)] }); outgoing.end(content); return;
        } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const response = await app.handle(new Request(url, {
        method: incoming.method, headers: incoming.headers,
        ...(["GET", "HEAD"].includes(incoming.method) ? {} : { body: Buffer.concat(chunks) }),
      }));
      const headers = Object.fromEntries(response.headers);
      if (response.headers.getSetCookie().length) headers["set-cookie"] = response.headers.getSetCookie();
      outgoing.writeHead(response.status, headers);
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error("Isolated browser server:", error.message);
      outgoing.writeHead(500, { "content-type": "text/plain" }); outgoing.end("Test server failed");
    }
  });
  let origin;
  try {
    await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
    origin = `http://127.0.0.1:${server.address().port}`;
    return { app, origin, async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      app.close();
    } };
  } catch (error) { app.close(); throw error; }
}
