// Docker HEALTHCHECK: asks the worker's /healthz over the same socket (or
// port) the server uses. Exit 0 = healthy.
import { request } from "node:http";

const socketPath = process.env.RENDER_WORKER_SOCKET?.trim();
const options = socketPath
  ? { socketPath, path: "/healthz", method: "GET", timeout: 4_000 }
  : { host: "127.0.0.1", port: Number(process.env.RENDER_WORKER_PORT || 8790), path: "/healthz", method: "GET", timeout: 4_000 };

const req = request(options, (res) => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on("timeout", () => req.destroy(new Error("timeout")));
req.on("error", () => process.exit(1));
req.end();
