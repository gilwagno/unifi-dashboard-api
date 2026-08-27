import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';

vi.mock('../../src/services/unifi-events.hub.js', () => ({
  unifiEventsHub: {
    subscribe: vi.fn((listener: (data: string) => void) => {
      listener(JSON.stringify({ hello: 'world' }));
      return () => {};
    }),
  },
}));

const { buildApp } = await import('../../src/app.js');
const { unifiEventsHub } = await import('../../src/services/unifi-events.hub.js');

// injectWS (helper de teste do @fastify/websocket) trava com essa
// combinação de plugins registrados (auth via @fastify/jwt + rate-limit +
// as rotas do app), então os testes abaixo usam um socket TCP real
// (app.listen + cliente `ws`) em vez de injectWS.
let apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps = [];
});

async function connect() {
  const app = await buildApp();
  apps.push(app);
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const ws = new WebSocket(`${address.replace('http', 'ws')}/ws/events`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return { app, ws };
}

function waitForMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => ws.once('message', (data) => resolve(data.toString())));
}

function waitForClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}

describe('/ws/events', () => {
  it('autentica com token válido na primeira mensagem e recebe eventos do hub', async () => {
    const { app, ws } = await connect();
    const token = app.jwt.sign({ sub: 'admin' });

    ws.send(JSON.stringify({ token }));

    const message = await waitForMessage(ws);
    expect(JSON.parse(message)).toEqual({ hello: 'world' });
    expect(unifiEventsHub.subscribe).toHaveBeenCalled();

    ws.terminate();
  });

  it('fecha com 1008 se o token da primeira mensagem for inválido', async () => {
    const { ws } = await connect();

    ws.send(JSON.stringify({ token: 'lixo-invalido' }));

    const code = await waitForClose(ws);
    expect(code).toBe(1008);
  });

  it('fecha com 1008 se a primeira mensagem não trouxer token', async () => {
    const { ws } = await connect();

    ws.send(JSON.stringify({ foo: 'bar' }));

    const code = await waitForClose(ws);
    expect(code).toBe(1008);
  });

  it('ignora mensagens depois de autenticado (canal somente leitura pro cliente)', async () => {
    const { app, ws } = await connect();
    const token = app.jwt.sign({ sub: 'admin' });

    ws.send(JSON.stringify({ token }));
    await waitForMessage(ws);

    const subscribeCallsBefore = vi.mocked(unifiEventsHub.subscribe).mock.calls.length;
    ws.send(JSON.stringify({ token }));
    // dá um tick pro servidor processar (se fosse reprocessar, chamaria
    // subscribe de novo — o que a rota deliberadamente evita)
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(vi.mocked(unifiEventsHub.subscribe).mock.calls.length).toBe(subscribeCallsBefore);

    ws.terminate();
  });
});
