// local-channel/state-probe.js — 内部状态脱敏快照
export function snapshotForProbe(userId, state) {
  const {
    pendingFiles, fileAnchors, conversationHistory,
    typingTicketCache, dailyStats, welcomedUsers, lastContact,
  } = state;

  const pendingEntry = pendingFiles.get(userId);
  const anchorEntry = fileAnchors.get(userId);
  const historyEntry = conversationHistory.get(userId);

  return {
    user_id: userId,
    pending_files: pendingEntry ? {
      count: pendingEntry.files.length,
      names: pendingEntry.files.map(f => f.fileName || f.type || "unknown"),
      total_chars: pendingEntry.files.reduce((s, f) => s + (f.text ? f.text.length : 0), 0),
      age_ms: Date.now() - pendingEntry.timestamp,
    } : null,
    file_anchors: anchorEntry ? {
      count: anchorEntry.length,
      total_chars: anchorEntry.reduce((s, a) => s + (a.content ? a.content.length : 0), 0),
      turns: anchorEntry.map(a => a.turnCount),
    } : null,
    conversation_history: historyEntry ? {
      message_count: historyEntry.messages.length,
      last_activity_ms: Date.now() - historyEntry.lastActivity,
    } : null,
    welcomed: welcomedUsers.has(userId),
    daily_stats: {
      date: dailyStats.date,
      message_count: dailyStats.messageCount,
      input_tokens: dailyStats.inputTokens,
      output_tokens: dailyStats.outputTokens,
    },
    last_contact: lastContact.fromId === userId ? { from_id: lastContact.fromId } : null,
  };
}
