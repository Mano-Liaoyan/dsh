/** Typed Session deletion copy, with English fallback for other application locales. */
export const en = {
  delete: 'Delete session',
  title: 'Delete this session?',
  description: 'Stop any running work in “{title}” and permanently delete its saved conversation. This cannot be undone. Files in your workspace are not deleted.',
  safety: 'You can also delete the session currently on screen. Remove its scheduled tasks first.',
  cancel: 'Cancel',
  close: 'Close',
  confirm: 'Delete permanently',
  'result.deleted': 'Session deleted.',
  'result.not-found': 'The session is already gone. Refresh the session list.',
  'result.in-use': 'This session is still busy. Stop its work and try again.',
  'result.confirmation-required': 'Deletion needs confirmation. Open Delete session and confirm again.',
  'result.unsupported': 'This storage provider cannot delete sessions. Use a provider that supports deletion.',
  'result.scheduled': 'Remove this session’s scheduled tasks before trying again.',
  'result.related-session': 'A related session is still busy. Stop its work and try again.',
  'result.failed': 'Deletion could not be confirmed. Check the session list before trying again.',
  'result.unavailable': 'Deletion could not be confirmed. Check the session list before trying again.',
} as const

/** Simplified Chinese dictionary with the same complete key set. */
export const zh: Record<keyof typeof en, string> = {
  delete: '删除会话',
  title: '删除此会话？',
  description: '停止“{title}”中正在进行的工作，并永久删除保存的对话，且无法撤销。工作区中的文件不会被删除',
  safety: '当前屏幕上显示的会话也可以删除。请先移除该会话的定时任务',
  cancel: '取消',
  close: '关闭',
  confirm: '永久删除',
  'result.deleted': '会话已删除',
  'result.not-found': '此会话已不存在，请刷新会话列表',
  'result.in-use': '此会话仍在忙碌，请先停止其中的工作后再试',
  'result.confirmation-required': '删除需要确认，请重新打开“删除会话”并确认',
  'result.unsupported': '此存储服务不支持删除会话，请使用支持删除的存储服务',
  'result.scheduled': '请先移除此会话的定时任务后再试',
  'result.related-session': '关联会话仍在忙碌，请先停止其中的工作后再试',
  'result.failed': '无法确认删除结果，请先检查会话列表后再试',
  'result.unavailable': '无法确认删除结果，请先检查会话列表后再试',
}
