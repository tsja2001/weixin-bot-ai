// local-channel/index.js — 对外 API 入口
import { drainAll, waitForMessage, enqueue as inboxEnqueue } from "./inbox.js";
import { push as outboxPush } from "./outbox.js";
import { createServer } from "./http-server.js";
import { snapshotForProbe as probeSnapshot } from "./state-probe.js";

let _enabled = false;

export function isLocalEnabled() {
  if (_enabled) return true;
  if (process.env.LOCAL_TEST_PORT) {
    _enabled = true;
    return true;
  }
  return false;
}

export function isLocalId(id) {
  return isLocalEnabled() && typeof id === "string" && id.startsWith("local:");
}

export function drainLocalInbox() {
  return drainAll();
}

export function onLocalInboxReady({ timeout_ms }) {
  return waitForMessage({ timeout_ms });
}

export function deliverToLocal(event) {
  outboxPush(event);
}

let _snapshotFn = null;
let _resetFn = null;

export function initLocalChannel({ port, snapshotForProbe: snapFn, resetUser }) {
  _snapshotFn = snapFn;
  _resetFn = resetUser;
  createServer({
    port,
    snapshotForProbe: (userId) => snapFn(userId),
    resetUser,
  });
}

export function snapshotForProbe(userId, state) {
  return probeSnapshot(userId, state);
}
