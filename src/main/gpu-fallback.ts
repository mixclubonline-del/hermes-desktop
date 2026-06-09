import { app } from "electron";
import { existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

// Some machines — notably Windows boxes running remote-control software that
// installs virtual display adapters (Todesk, GameViewer/向日葵, TeamViewer,
// Sunlogin, etc.) — confuse Chromium's GPU initialization. The GPU process
// crashes on launch, Chromium retries ~9 times and then fatally exits with
// "GPU process isn't usable. Goodbye." (issue #592).
//
// Passing --disable-gpu on the external command line doesn't reliably help
// because the GPU process still attempts to initialize. The robust fix is to
// disable hardware acceleration from inside the main process *before* the app
// is ready, and to remember that choice across launches once we've seen the
// GPU process die.

// Resolve the flag path once, at module load — before app.setName() runs in
// whenReady — so the path the crash guard writes to is the same one we read
// from on the next launch (app.getPath("userData") depends on app.name).
let cachedFlagPath: string | null = null;

function flagPath(): string {
  if (!cachedFlagPath) {
    cachedFlagPath = join(app.getPath("userData"), "disable-gpu.flag");
  }
  return cachedFlagPath;
}

/**
 * True when hardware acceleration should be disabled — either because a
 * previous launch detected a fatal GPU crash and persisted the flag, or
 * because the user forced it via HERMES_DISABLE_GPU=1.
 */
export function isGpuDisabled(): boolean {
  if (process.env.HERMES_DISABLE_GPU === "1") return true;
  try {
    return existsSync(flagPath());
  } catch {
    return false;
  }
}

/**
 * Apply GPU-disabling switches. MUST be called before app is ready (i.e. at
 * module load, before app.whenReady()), otherwise app.disableHardwareAcceleration()
 * throws and the command-line switches are ignored.
 */
export function applyGpuPreferences(): void {
  if (!isGpuDisabled()) return;
  console.warn(
    "[GPU] Hardware acceleration disabled (software rendering). " +
      "Set HERMES_DISABLE_GPU=0 or delete the disable-gpu.flag file to re-enable.",
  );
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-software-rasterizer");
}

function persistGpuDisabled(): void {
  try {
    const dir = app.getPath("userData");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(flagPath(), new Date().toISOString(), "utf-8");
  } catch (err) {
    console.error("[GPU] Failed to persist disable-gpu flag:", err);
  }
}

/**
 * Watch for fatal GPU process crashes. When the GPU process dies abnormally
 * (the symptom on machines with virtual display adapters), persist the
 * disable-gpu flag and relaunch the app with software rendering instead of
 * letting Chromium retry-then-fatally-exit. Only acts once per launch.
 *
 * Register this early (before app is ready); the event itself fires later.
 */
export function installGpuCrashGuard(): void {
  // Already running with GPU disabled — nothing left to guard against.
  if (isGpuDisabled()) return;

  let recovering = false;
  app.on("child-process-gone", (_event, details) => {
    if (details.type !== "GPU") return;
    // A clean exit isn't a crash — ignore it.
    if (details.reason === "clean-exit") return;
    if (recovering) return;
    recovering = true;

    console.error(
      `[GPU] GPU process gone (reason=${details.reason}, exitCode=${details.exitCode}). ` +
        "Disabling hardware acceleration and relaunching with software rendering.",
    );
    persistGpuDisabled();
    app.relaunch();
    app.exit(0);
  });
}
