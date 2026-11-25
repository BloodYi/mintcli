import { WebSocket, type RawData } from 'ws';

const MAX_PENDING_FRAMES = 64;
const MAX_PENDING_BYTES = 1024 * 1024;

function rawDataByteLength(data: RawData): number {
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return 0;
}

/**
 * Proxies an authenticated client websocket to a plugin websocket endpoint.
 */
export function handlePluginWsProxy(
  clientWs: WebSocket,
  pathname: string,
  getPluginPort: (pluginName: string) => number | null
): void {
  const pluginName = pathname.replace('/plugin-ws/', '');
  if (!pluginName || /[^a-zA-Z0-9_-]/.test(pluginName)) {
    clientWs.close(4400, 'Invalid plugin name');
    return;
  }

  const port = getPluginPort(pluginName);
  if (!port) {
    clientWs.close(4404, 'Plugin not running');
    return;
  }

  const upstream = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const pendingFrames: Array<{ data: RawData; isBinary: boolean }> = [];
  let pendingBytes = 0;

  const handleUpstreamError = (error: Error) => {
    pendingFrames.length = 0;
    pendingBytes = 0;
    console.error(`[Plugins] WS proxy error for "${pluginName}":`, error.message);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(4502, 'Upstream error');
    }
  };

  const disposeUpstream = () => {
    pendingFrames.length = 0;
    pendingBytes = 0;
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.close();
    } else if (upstream.readyState === WebSocket.CONNECTING) {
      // Detach normal error handler and suppress handshake-abort error on intentional teardown.
      upstream.off('error', handleUpstreamError);
      upstream.on('error', () => undefined);
      upstream.terminate();
    }
  };

  upstream.on('open', () => {
    console.log(`[Plugins] WS proxy connected to "${pluginName}" on port ${port}`);
    if (clientWs.readyState !== WebSocket.OPEN) {
      disposeUpstream();
      return;
    }
    while (pendingFrames.length > 0 && upstream.readyState === WebSocket.OPEN) {
      const frame = pendingFrames.shift()!;
      upstream.send(frame.data, { binary: frame.isBinary });
    }
    pendingBytes = 0;
  });

  upstream.on('message', (data, isBinary) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary });
    }
  });

  clientWs.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
      return;
    }
    if (upstream.readyState === WebSocket.CONNECTING) {
      const size = rawDataByteLength(data);
      if (pendingFrames.length >= MAX_PENDING_FRAMES || pendingBytes + size > MAX_PENDING_BYTES) {
        disposeUpstream();
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.close(1009, 'Handshake buffer exceeded');
        }
        return;
      }
      pendingFrames.push({ data, isBinary });
      pendingBytes += size;
    }
  });

  upstream.on('close', () => {
    pendingFrames.length = 0;
    pendingBytes = 0;
    if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
      clientWs.close();
    }
  });

  clientWs.on('close', disposeUpstream);

  upstream.on('error', handleUpstreamError);

  clientWs.on('error', disposeUpstream);
}
