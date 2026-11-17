// Executes a top-up on an existing ICCID and verifies the eSIM's resources afterwards.

import { addPlanToIccid, getSimInfo, resourceSnapshot, resourcesChanged } from "./yesim.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function snapshot(env, iccid) {
  try {
    const raw = await getSimInfo(env, iccid);
    return { known: true, found: Boolean(raw), snap: resourceSnapshot(raw) };
  } catch {
    return { known: false, found: false, snap: null };
  }
}

/**
 * Returns { status, verified, error }:
 *   status "success" – Yesim accepted the plan (verified=true once /sim_info shows the new resources)
 *   status "failed"  – Yesim definitely refused; nothing was applied
 *   status "review"  – outcome unknown (timeout / 5xx and no visible change); must NOT be retried blindly
 */
export async function performTopup(env, iccid, planId, { verifyDelayMs = 1500, verifyAttempts = 3 } = {}) {
  const before = await snapshot(env, iccid);
  if (before.known && !before.found) {
    return { status: "failed", verified: false, error: "iccid_not_found" };
  }

  const result = await addPlanToIccid(env, iccid, planId);

  if (result.outcome === "rejected") {
    return { status: "failed", verified: false, error: `rejected:${result.detail}` };
  }

  // Verify updated resources (also resolves "unknown" outcomes when the plan did land).
  let verified = false;
  if (before.known) {
    for (let attempt = 0; attempt < verifyAttempts && !verified; attempt += 1) {
      if (attempt > 0 || result.outcome === "unknown") await sleep(verifyDelayMs);
      const after = await snapshot(env, iccid);
      if (after.known && after.found && resourcesChanged(before.snap, after.snap, planId)) verified = true;
    }
  }

  if (result.outcome === "success") return { status: "success", verified, error: null };
  if (verified) return { status: "success", verified: true, error: null };
  return { status: "review", verified: false, error: `unknown:${result.detail}` };
}
