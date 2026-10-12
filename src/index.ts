import { spawnSync } from "child_process";
import { Socket } from "net";
import { writeFileSync, mkdirSync } from "fs";

export interface PhoneSentinelConfig {
  lanIp: string;
  tailscaleIp: string;
  adbBin: string;
  pollIntervalMs: number;
  httpPort: number;
}

export class PhoneSentinel {
  private config: PhoneSentinelConfig;
  private currentTarget: string | null = null;
  private lastState: "CONNECTED" | "DISCONNECTED" | "SCANNING" = "DISCONNECTED";
  private deviceModel: string | null = null;
  private lastSeen: Date | null = null;

  constructor(config: Partial<PhoneSentinelConfig> = {}) {
    this.config = {
      lanIp: config.lanIp || process.env.PIXEL_LAN_IP || "10.0.0.77",
      tailscaleIp: config.tailscaleIp || process.env.PIXEL_TAILSCALE_IP || "100.123.57.58",
      adbBin: config.adbBin || process.env.ADB_BIN || "/opt/android-sdk/platform-tools/adb",
      pollIntervalMs: config.pollIntervalMs || 5000,
      httpPort: config.httpPort || Number(process.env.PORT) || 25178,
    };
  }

  /**
   * Fast non-blocking TCP connect check to find live ports.
   */
  private async isPortOpen(ip: string, port: number, timeoutMs = 80): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new Socket();
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
      socket.connect(port, ip);
    });
  }

  /**
   * Concurrently scan port candidate ranges on an IP
   */
  public async scanPorts(ip: string, start = 30000, end = 50000): Promise<number[]> {
    const BATCH = 300;
    const open: number[] = [];
    for (let p = start; p <= end; p += BATCH) {
      const batchEnd = Math.min(p + BATCH - 1, end);
      const promises: Promise<number | null>[] = [];
      for (let cur = p; cur <= batchEnd; cur++) {
        promises.push(this.isPortOpen(ip, cur).then(isOpen => isOpen ? cur : null));
      }
      const results = await Promise.all(promises);
      for (const res of results) {
        if (res !== null) open.push(res);
      }
    }
    return open;
  }

  /**
   * Check if an open port responds to ADB TLS protocol
   */
  public async checkAdbProtocol(ip: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new Socket();
      socket.setTimeout(300);
      socket.once("connect", () => {
        // Send ADB CNXN header probe
        socket.write("CNXN\x00\x00\x00\x01\x00\x10\x00\x00\x07\x00\x00\x00\x32\x02\x00\x00\xbc\xb1\xa7\xb1host::\x00");
      });
      socket.once("data", (data) => {
        socket.destroy();
        // Modern wireless ADB responds with STLS (TLS upgrade request) or AUTH
        const header = data.toString("latin1").slice(0, 4);
        resolve(header === "STLS" || header === "AUTH" || header === "CNXN");
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
      socket.connect(port, ip);
    });
  }

  /**
   * Check current adb devices status for genuine active Pixel
   */
  public getActiveDevice(): { serial: string; state: string } | null {
    const res = spawnSync(this.config.adbBin, ["devices", "-l"], { encoding: "utf8" });
    if (res.status !== 0 || !res.stdout) return null;

    const lines = res.stdout.split("\n");
    for (const line of lines) {
      if ((line.includes(this.config.lanIp) || line.includes(this.config.tailscaleIp)) && line.includes("device") && !line.includes("offline")) {
        const parts = line.trim().split(/\s+/);
        return { serial: parts[0], state: parts[1] };
      }
    }
    return null;
  }

  /**
   * Attempt reactive reconnect
   */
  public async heal(): Promise<boolean> {
    this.lastState = "SCANNING";

    // Try LAN IP first, then Tailscale IP if off LAN
    const ipsToTry = [this.config.lanIp, this.config.tailscaleIp];

    for (const ip of ipsToTry) {
      // Quick check if host IP is reachable at all before port scanning
      const openPorts = await this.scanPorts(ip, 30000, 50000);
      if (openPorts.length === 0) continue;

      for (const port of openPorts) {
        const isAdb = await this.checkAdbProtocol(ip, port);
        if (isAdb) {
          const target = `${ip}:${port}`;
          spawnSync(this.config.adbBin, ["connect", target], { encoding: "utf8" });
          
          const active = this.getActiveDevice();
          if (active && active.serial === target) {
            this.currentTarget = target;
            this.lastState = "CONNECTED";
            this.lastSeen = new Date();
            this.recordVital(target);
            return true;
          }
        }
      }
    }

    this.lastState = "DISCONNECTED";
    return false;
  }

  private recordVital(target: string): void {
    const modelRes = spawnSync(this.config.adbBin, ["-s", target, "shell", "getprop", "ro.product.model"], { encoding: "utf8" });
    if (modelRes.status === 0 && modelRes.stdout) {
      this.deviceModel = modelRes.stdout.trim();
    }
  }

  /**
   * Start HTTP health & status endpoint for pitchfork/mise and start supervisory loop
   */
  public start(): void {
    console.log(`[phone-sentinel] Starting sentinel supervisor on port ${this.config.httpPort}`);

    Bun.serve({
      port: this.config.httpPort,
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/health") {
          return new Response(JSON.stringify({
            status: this.lastState === "CONNECTED" ? "ok" : "degraded",
            state: this.lastState,
            target: this.currentTarget,
            model: this.deviceModel,
            lastSeen: this.lastSeen,
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.pathname === "/status") {
          return new Response(JSON.stringify({
            sentinel: "phone-sentinel",
            config: this.config,
            state: this.lastState,
            target: this.currentTarget,
            model: this.deviceModel,
            lastSeen: this.lastSeen,
          }, null, 2), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    // Run continuous supervisory loop
    setInterval(async () => {
      const active = this.getActiveDevice();
      if (active) {
        this.currentTarget = active.serial;
        this.lastState = "CONNECTED";
        this.lastSeen = new Date();
      } else {
        await this.heal();
      }
    }, this.config.pollIntervalMs);

    // Initial pass
    this.heal();
  }
}

if (import.meta.main) {
  const sentinel = new PhoneSentinel();
  sentinel.start();
}
