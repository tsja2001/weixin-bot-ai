// local-channel/outbox.js — 出站事件队列与长轮询
const events = [];
let seq = 0;
let notifyResolve = null;

export function push(event) {
  seq++;
  const entry = { seq, ts: new Date().toISOString(), ...event };
  events.push(entry);
  if (notifyResolve) {
    const r = notifyResolve;
    notifyResolve = null;
    r();
  }
}

export function getEventsSince(since) {
  return events.filter(e => e.seq > since);
}

export function waitForEvents({ since, timeout_ms }) {
  const existing = getEventsSince(since);
  if (existing.length > 0) return Promise.resolve(existing);

  return new Promise(resolve => {
    notifyResolve = resolve;
    const timer = setTimeout(() => {
      if (notifyResolve === resolve) {
        notifyResolve = null;
        resolve([]);
      }
    }, timeout_ms);
    // When notify fires, clear the timer
    const origResolve = resolve;
    notifyResolve = (events) => {
      clearTimeout(timer);
      origResolve(getEventsSince(since));
    };
  });
}

export function reset(user_id) {
  // Remove events for a specific user (or all if no user_id)
  if (user_id) {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].to_user_id === user_id) {
        events.splice(i, 1);
      }
    }
  } else {
    events.length = 0;
    seq = 0;
  }
}

export function getNextSeq() {
  return seq + 1;
}
