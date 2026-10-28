import { describe, expect, it } from 'vitest';
import { applyAntigravityEvent, readAntigravityEvents } from '@/modules/antigravity/stream';

describe('native agy transport', () => {
  it('preserves split UTF-8, ignores heartbeat comments, and replaces partial text with authoritative snapshots', async () => {
    const bytes = new TextEncoder().encode(': keep-alive\r\n\r\ndata: {"event":"delta","delta":"你"}\r\n\r\ndata: {"event":"snapshot","message":{"id":"native","role":"assistant","content":"你好"}}\n\ndata: {"event":"done","status":"complete"}\n\n');
    const response = new Response(new ReadableStream({ start(controller) {
      for (let index = 0; index < bytes.length; index += 3) controller.enqueue(bytes.slice(index, index + 3));
      controller.close();
    } }));
    let message = { id: 'temporary', role: 'assistant', content: '' };
    await readAntigravityEvents(response, event => { message = { ...message, ...applyAntigravityEvent(message, event) }; });
    expect(message).toMatchObject({ id: 'native', content: '你好' });
  });
  it('treats a stream without a terminal event as disconnected instead of successful', async () => {
    await expect(readAntigravityEvents(new Response('data: {"event":"delta","delta":"partial"}\n\n'), () => {})).rejects.toThrow('连接中断');
  });
});
