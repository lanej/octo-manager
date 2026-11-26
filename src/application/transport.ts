import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import type { ConnectRouter } from "@connectrpc/connect";
import { responseMaxBytes } from "../api/limits.js";

export class ApiTransport {
  private server: Server | undefined;
  private sockets = new Set<Socket>();
  private routes: ((router: ConnectRouter) => void) | undefined;
  private ownsSocket = false;

  constructor(readonly socketPath: string) {}

  get listening(): boolean {
    return this.server?.listening === true;
  }

  configure(routes: (router: ConnectRouter) => void): void {
    if (this.routes) throw new Error("API routes already configured");
    this.routes = routes;
  }

  async listen(): Promise<void> {
    const routes = this.routes;
    if (!routes) throw new Error("API routes not configured");
    // The store's ownership lock must already be held before touching the control path.
    if (existsSync(this.socketPath)) {
      if (!lstatSync(this.socketPath).isSocket()) throw new Error("Refusing to replace a non-socket control path");
      unlinkSync(this.socketPath);
    }
    const server = createServer(
      connectNodeAdapter({
        routes,
        readMaxBytes: 16384,
        writeMaxBytes: responseMaxBytes,
        grpc: false,
        grpcWeb: false,
      }),
    );
    this.server = server;
    server.headersTimeout = 5000;
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        this.ownsSocket = true;
        server.off("error", reject);
        resolve();
      });
    });
    chmodSync(this.socketPath, 0o600);
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    const server = this.server;
    if (server?.listening === true)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    if (this.ownsSocket && existsSync(this.socketPath)) unlinkSync(this.socketPath);
    this.ownsSocket = false;
  }
}
