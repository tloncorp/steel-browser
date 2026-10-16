import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { expect, it } from "vitest";
import { env } from "../../env.js";
import { CDPService } from "./cdp.service.js";
import { ShutdownReason } from "./plugins/core/base-plugin.js";

const executablePath = process.env.CHROME_EXECUTABLE_PATH || "/usr/bin/google-chrome";
if (!existsSync(executablePath))
  console.warn("Skipping browser launch test: set CHROME_EXECUTABLE_PATH to local Chrome.");

it.skipIf(!existsSync(executablePath))(
  "filters Puppeteer defaults as well as Steel arguments from the running browser",
  async () => {
    const previousEnv = { ...env };
    const profile = await mkdtemp(join(tmpdir(), "steel-launch-arguments-"));
    Object.assign(env, {
      CHROME_EXECUTABLE_PATH: executablePath,
      CHROME_HEADLESS: true,
      CHROME_USER_DATA_DIR: profile,
      DISABLE_CHROME_SANDBOX: true,
      SKIP_FINGERPRINT_INJECTION: true,
      FILTER_CHROME_ARGS: ["--disable-dev-shm-usage"],
      PROXY_URL: undefined,
    });
    const service = new CDPService(
      { keepAlive: false, cleanupFiles: false },
      pino({ level: "silent" }),
    );
    try {
      const browser = await service.launch();
      const args = browser.process()!.spawnargs;
      expect(args).not.toContain("--disable-dev-shm-usage");
      expect(args).not.toContain("--enable-automation");
      expect(args).toContain("--disable-background-networking");
      expect(args).toContain(`--user-data-dir=${profile}`);
    } finally {
      await service.shutdown(ShutdownReason.SESSION_END);
      Object.assign(env, previousEnv);
      await rm(profile, { recursive: true, force: true });
    }
  },
);
