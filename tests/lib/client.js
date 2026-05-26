// HTTP 客户端，封装所有本地通道端点
export class LocalClient {
  constructor(port) {
    this.base = `http://127.0.0.1:${port}`;
  }

  async _post(path, body) {
    const res = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  async _get(path) {
    const res = await fetch(`${this.base}${path}`);
    return res.json();
  }

  // ── 注入端点 ──

  /** 发送文本消息 */
  async sendText(user_id, text) {
    return this._post("/local/inbox/text", { user_id, text });
  }

  /** 发送文件消息 */
  async sendFile(user_id, file_path, file_name) {
    return this._post("/local/inbox/file", { user_id, file_path, file_name });
  }

  /** 发送图片消息 */
  async sendImage(user_id, file_path) {
    return this._post("/local/inbox/image", { user_id, file_path });
  }

  /** 发送原始 iLink JSON */
  async sendRaw(msg) {
    return this._post("/local/inbox/raw", { msg });
  }

  // ── 观察端点 ──

  /** 长轮询拉取 outbox 事件 */
  async pollOutbox(since, waitMs = 15000) {
    return this._get(`/local/outbox?since=${since}&wait_ms=${waitMs}`);
  }

  /** 立即拉取 outbox（不等待）*/
  async getOutbox(since = 0) {
    return this._get(`/local/outbox?since=${since}`);
  }

  /** 查看用户状态 */
  async getState(user_id = "local:default") {
    return this._get(`/local/state?user_id=${encodeURIComponent(user_id)}`);
  }

  /** 健康检查 */
  async health() {
    return this._get("/local/health");
  }

  // ── 管理 ──

  /** 重置用户状态 */
  async reset(user_id) {
    return this._post("/local/reset", user_id ? { user_id } : {});
  }

  // ── 高级 ──

  /**
   * 发送文本并等待回复，返回所有新事件。
   * 这是最常用的测试模式。
   */
  async sendAndWait(user_id, text, options = {}) {
    const { waitMs = 30000, since } = options;
    // 先获取当前 seq 作为游标起点
    const current = await this.getOutbox();
    const startSeq = since !== undefined ? since : current.next_seq - 1;

    // 发送消息
    await this.sendText(user_id, text);

    // 等待回复
    const result = await this.pollOutbox(Math.max(0, startSeq), waitMs);
    return result;
  }
}
