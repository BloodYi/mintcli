import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { WebSocket, WebSocketServer } from 'ws';

import { handlePluginWsProxy } from '../services/plugin-websocket-proxy.service.js';

test('handlePluginWsProxy buffers client frames sent during upstream handshake', async () => {
  const receivedByUpstream: string[] = [];
  const upstreamHttpServer = http.createServer();
  const upstreamWss = new WebSocketServer({ noServer: true });

  upstreamHttpServer.on('upgrade', (request, socket, head) => {
    // Delay the upstream handshake slightly so the client sends frames while upstream is CONNECTING.
    setTimeout(() => {
      upstreamWss.handleUpgrade(request, socket, head, (ws) => {
        ws.on('message', (data) => {
          const message = data.toString();
          receivedByUpstream.push(message);
          ws.send(`ack:${message}`);
        });
      });
    }, 30);
  });

  upstreamHttpServer.listen(0, '127.0.0.1');
  await once(upstreamHttpServer, 'listening');
  const upstreamPort = (upstreamHttpServer.address() as AddressInfo).port;

  const proxyHttpServer = http.createServer();
  const proxyWss = new WebSocketServer({ server: proxyHttpServer });
  proxyWss.on('connection', (clientWs, request) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    handlePluginWsProxy(clientWs, pathname, (name) => (name === 'demo-plugin' ? upstreamPort : null));
  });

  proxyHttpServer.listen(0, '127.0.0.1');
  await once(proxyHttpServer, 'listening');
  const proxyPort = (proxyHttpServer.address() as AddressInfo).port;

  try {
    const client = new WebSocket(`ws://127.0.0.1:${proxyPort}/plugin-ws/demo-plugin`);
    await once(client, 'open');

    const replies: string[] = [];
    const twoReplies = new Promise<void>((resolve) => {
      client.on('message', (data) => {
        replies.push(data.toString());
        if (replies.length === 2) resolve();
      });
    });

    // Sent immediately before the 30ms delayed upstream upgrade finishes.
    client.send('hello-1');
    client.send('hello-2');

    await twoReplies;
    assert.deepEqual(receivedByUpstream, ['hello-1', 'hello-2']);
    assert.deepEqual(replies, ['ack:hello-1', 'ack:ack:hello-2'.replace('ack:ack:', 'ack:')]);

    client.close();
    await once(client, 'close');
  } finally {
    proxyWss.close();
    upstreamWss.close();
    await new Promise<void>((resolve) => proxyHttpServer.close(() => resolve()));
    await new Promise<void>((resolve) => upstreamHttpServer.close(() => resolve()));
  }
});

test('handlePluginWsProxy terminates CONNECTING upstream when client disconnects early', async () => {
  let upstreamUpgraded = false;
  const pendingSockets = new Set<import('node:stream').Duplex>();
  const upstreamHttpServer = http.createServer();
  const upstreamWss = new WebSocketServer({ noServer: true });

  upstreamHttpServer.on('upgrade', (request, socket, head) => {
    pendingSockets.add(socket);
    socket.on('close', () => pendingSockets.delete(socket));
    socket.on('end', () => socket.destroy());
    socket.resume();
    setTimeout(() => {
      if (socket.destroyed || !socket.writable) return;
      upstreamUpgraded = true;
      upstreamWss.handleUpgrade(request, socket, head, () => undefined);
    }, 80);
  });

  upstreamHttpServer.listen(0, '127.0.0.1');
  await once(upstreamHttpServer, 'listening');
  const upstreamPort = (upstreamHttpServer.address() as AddressInfo).port;

  const proxyHttpServer = http.createServer();
  const proxyWss = new WebSocketServer({ server: proxyHttpServer });
  proxyWss.on('connection', (clientWs, request) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    handlePluginWsProxy(clientWs, pathname, () => upstreamPort);
  });

  proxyHttpServer.listen(0, '127.0.0.1');
  await once(proxyHttpServer, 'listening');
  const proxyPort = (proxyHttpServer.address() as AddressInfo).port;

  try {
    const client = new WebSocket(`ws://127.0.0.1:${proxyPort}/plugin-ws/demo-plugin`);
    await once(client, 'open');
    client.close();
    await once(client, 'close');

    await new Promise((resolve) => setTimeout(resolve, 110));
    assert.equal(upstreamUpgraded, false);
    assert.equal(pendingSockets.size, 0);
  } finally {
    for (const socket of pendingSockets) socket.destroy();
    proxyWss.close();
    upstreamWss.close();
    await new Promise<void>((resolve) => proxyHttpServer.close(() => resolve()));
    await new Promise<void>((resolve) => upstreamHttpServer.close(() => resolve()));
  }
});
