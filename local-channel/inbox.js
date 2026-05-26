// local-channel/inbox.js — 本地消息注入队列与 iLink 格式构造器
import crypto from "crypto";
import fs from "fs";

const inbox = [];
let notifyResolve = null;

export function enqueue(msg) {
  inbox.push(msg);
  if (notifyResolve) {
    const r = notifyResolve;
    notifyResolve = null;
    r();
  }
}

export function drainAll() {
  if (inbox.length === 0) return [];
  const msgs = inbox.splice(0);
  return msgs;
}

export function waitForMessage({ timeout_ms }) {
  if (inbox.length > 0) return Promise.resolve();
  return new Promise(resolve => {
    notifyResolve = resolve;
    setTimeout(() => {
      if (notifyResolve === resolve) {
        notifyResolve = null;
        resolve();
      }
    }, timeout_ms);
  });
}

function baseMsg(user_id) {
  const ts = Date.now();
  return {
    seq: 0,
    message_id: "local-" + crypto.randomUUID(),
    from_user_id: user_id,
    to_user_id: "",
    client_id: "local-test-" + crypto.randomBytes(4).toString("hex"),
    create_time_ms: ts,
    update_time_ms: ts,
    delete_time_ms: 0,
    session_id: "",
    group_id: "",
    message_type: 1,
    message_state: 2,
    context_token: "local-ctx-" + crypto.randomBytes(12).toString("hex"),
  };
}

function baseItem(type) {
  const ts = Date.now();
  return {
    type,
    create_time_ms: ts,
    update_time_ms: ts,
    is_completed: true,
    button_item_list: [],
  };
}

export function buildMsgFromText({ user_id, text }) {
  const msg = baseMsg(user_id);
  msg.item_list = [{
    ...baseItem(1),
    text_item: { text },
  }];
  return msg;
}

export function buildMsgFromFile({ user_id, file_path, file_name }) {
  const absPath = fs.realpathSync(file_path);
  const stat = fs.statSync(absPath);
  const name = file_name || file_path.split("/").pop();
  const msg = baseMsg(user_id);
  msg.item_list = [{
    ...baseItem(4),
    file_item: {
      file_name: name,
      len: stat.size,
      md5: "",
      media: {
        _local_path: absPath,
        full_url: "local://",
        aes_key: "",
        encrypt_query_param: "",
      },
    },
  }];
  return msg;
}

export function buildMsgFromImage({ user_id, file_path }) {
  const absPath = fs.realpathSync(file_path);
  const msg = baseMsg(user_id);
  msg.item_list = [{
    ...baseItem(2),
    image_item: {
      aeskey: "",
      media: {
        _local_path: absPath,
        full_url: "local://",
        aes_key: "",
        encrypt_query_param: "",
      },
    },
  }];
  return msg;
}

export function buildMsgFromRaw({ msg }) {
  return msg;
}
