import { createServer } from "node:http";
import { SPEC_VERSION } from "@epok/core";

/**
 * Tiny no-framework demo placeholder.
 * Later slices wire attach → persist → replay → validate on this server.
 */
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end(`epok demo (Interaction spec ${SPEC_VERSION})\n`);
});

const port = Number(process.env.PORT ?? 3456);
server.listen(port, () => {
  console.log(`epok demo listening on http://127.0.0.1:${port}`);
});
