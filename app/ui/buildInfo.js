// app/ui/buildInfo.js
import { app } from "../state.js";

/** Inject a small build/version tag into the page if #buildTag exists. */
export function applyBuildTag() {
  const el = document.getElementById("buildTag");
  if (!el) {
    // If scripts load before the tag exists, retry once after DOM is ready.
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => applyBuildTag(), { once: true });
    }
    return;
  }

  const parts = [];
  if (app.buildVersion) parts.push(app.buildVersion);
  if (app.buildDate) parts.push(app.buildDate);
  el.textContent = parts.join(" • ");
  el.title = `Build: ${app.buildCodename || ""}`.trim();
}

/** Log build info (helps when debugging across many tabs). */
export function logBuildInfo() {
  const msg = `[Reech Darts] ${app.buildVersion || ""} (${app.buildCodename || ""}) ${app.buildDate || ""}`.trim();
  console.log(msg);
}
