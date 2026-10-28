import type { AntigravityMessage, AntigravityStreamEvent } from '@/shared/types';

/** Used by the native chat subscriber and transport fixtures; handles split UTF-8 and SSE heartbeats. */
export async function readAntigravityEvents(response: Response, receive: (event: AntigravityStreamEvent) => void) {
  if (!response.body) throw new Error('服务器没有返回回复内容。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let completed = false;
  const consume = (block: string) => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    const event = JSON.parse(data) as AntigravityStreamEvent;
    receive(event);
    if (event.event === 'done') completed = true;
  };
  try {
    while (!completed) {
      const chunk = await reader.read();
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        consume(pending.slice(0, boundary.index));
        pending = pending.slice(boundary.index + boundary[0].length);
      }
      if (chunk.done) { if (pending.trim()) consume(pending); break; }
    }
    if (!completed) throw new Error('连接中断，回复可能仍在服务器生成。请点击同步聊天接续，避免重复发送。');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Used by the live message view and fixtures; final server snapshots replace partial text. */
export function applyAntigravityEvent(message: AntigravityMessage, event: AntigravityStreamEvent): AntigravityMessage {
  if (event.event === 'snapshot' && event.message) return { ...message, ...event.message };
  if (event.event === 'delta') return { ...message, content: message.content + String(event.delta ?? event.text ?? '') };
  if (event.event === 'thinking') return { ...message, thinking: event.mode === 'snapshot'
    ? String(event.thinking ?? '') : (message.thinking || '') + String(event.thinking ?? event.delta ?? '') };
  if (event.event === 'result' && event.response) return { ...message, content: event.response };
  if (event.event === 'tool') return { ...message, tool: String(event.tool || event.name || '正在执行工具') };
  if (event.event === 'error') return { ...message, status: 'error', errorText: String(event.error || '生成失败') };
  return message;
}
