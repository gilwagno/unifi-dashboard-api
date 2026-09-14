import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Onda de Robustez, item 2 — limite dedicado da porta de entrada.
//
// `/auth/login` é a ÚNICA rota que um atacante alcança sem credencial, com
// usuário conhecido e único. Até esta mudança ela caía no limite global
// (100/min) — dez vezes mais folgada que `/clients/block`, que exige estar
// autenticado. Estes testes existem para que essa proteção não suma em
// silêncio num refactor futuro.
//
// `vi.resetModules()` + reimport dinâmico: `src/config/env.ts` lê
// `process.env` UMA vez, na carga do módulo. Sem resetar, o segundo teste
// herdaria o limite do primeiro — e os testes de `TRUST_PROXY` abaixo
// afirmariam nada.

async function buildWith(envVars: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(envVars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const { buildApp } = await import('../../src/app.js');
  return buildApp();
}

const CREDENCIAL_ERRADA = { username: 'admin', password: 'senha-errada' };

beforeEach(() => {
  delete process.env.RATE_LIMIT_LOGIN_MAX;
  delete process.env.TRUST_PROXY;
});

afterEach(() => {
  delete process.env.RATE_LIMIT_LOGIN_MAX;
  delete process.env.TRUST_PROXY;
});

describe('/auth/login — limite dedicado', () => {
  it('a partir da (N+1)-ésima tentativa devolve 429', async () => {
    const app = await buildWith({ RATE_LIMIT_LOGIN_MAX: '3' });

    const status: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({ method: 'POST', url: '/auth/login', payload: CREDENCIAL_ERRADA });
      status.push(res.statusCode);
    }

    // As 3 primeiras respondem pelo mérito (401, credencial errada); só a
    // 4ª é barrada pelo limite. Afirmar só "alguma deu 429" deixaria passar
    // um limite errado por um.
    expect(status.slice(0, 3)).toEqual([401, 401, 401]);
    expect(status[3]).toBe(429);
    await app.close();
  });

  it('o limite do login é MAIS restrito que o global — é a inversão de risco que isto corrige', async () => {
    const app = await buildWith({ RATE_LIMIT_LOGIN_MAX: '2', RATE_LIMIT_MAX: '100' });

    await app.inject({ method: 'POST', url: '/auth/login', payload: CREDENCIAL_ERRADA });
    await app.inject({ method: 'POST', url: '/auth/login', payload: CREDENCIAL_ERRADA });
    const terceira = await app.inject({ method: 'POST', url: '/auth/login', payload: CREDENCIAL_ERRADA });

    // Com o limite global de 100 valendo, a 3ª passaria. É o limite
    // DEDICADO que a barra — se ele sumisse, este teste ficaria vermelho.
    expect(terceira.statusCode).toBe(429);
    await app.close();
  });

  it('o contador é POR IP: um IP bloqueado não derruba o login de outro', async () => {
    const app = await buildWith({ RATE_LIMIT_LOGIN_MAX: '2', TRUST_PROXY: 'true' });

    const deA = () =>
      app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: CREDENCIAL_ERRADA,
        headers: { 'x-forwarded-for': '203.0.113.10' },
      });
    const deB = () =>
      app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: CREDENCIAL_ERRADA,
        headers: { 'x-forwarded-for': '203.0.113.99' },
      });

    await deA();
    await deA();
    expect((await deA()).statusCode).toBe(429); // A estourou

    // B nunca tentou: tem que continuar sendo atendido pelo mérito.
    expect((await deB()).statusCode).toBe(401);
    await app.close();
  });
});

// O ponto que faria esta proteção passar nos testes e FALHAR em produção.
//
// O projeto tem o Cloudflare Tunnel no roadmap. Atrás de um proxy, o IP do
// socket é o do PROXY, igual para todo mundo. Sem `trustProxy`, o limite por
// IP vira um limite GLOBAL: 5 erros de qualquer pessoa trancam o login de
// todos os outros. Com `trustProxy`, o Fastify lê o `X-Forwarded-For`.
//
// E a direção oposta é pior: `trustProxy` LIGADO sem proxy real na frente
// deixa qualquer um mandar um `X-Forwarded-For` diferente a cada
// requisição, e o rate limit nunca dispara. Por isso o default é `false`.
describe('TRUST_PROXY — de onde sai o IP que o rate limit conta', () => {
  it('DESLIGADO (default): o X-Forwarded-For é IGNORADO e todos compartilham o contador', async () => {
    const app = await buildWith({ RATE_LIMIT_LOGIN_MAX: '2', TRUST_PROXY: undefined });

    const comIp = (ip: string) =>
      app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: CREDENCIAL_ERRADA,
        headers: { 'x-forwarded-for': ip },
      });

    await comIp('203.0.113.1');
    await comIp('203.0.113.2');
    // IP "diferente", mas o header não é confiado: o contador é o mesmo.
    // É este comportamento que protege contra spoofing quando NÃO há proxy.
    expect((await comIp('203.0.113.3')).statusCode).toBe(429);
    await app.close();
  });

  it('LIGADO: o X-Forwarded-For passa a valer e cada IP tem seu próprio contador', async () => {
    const app = await buildWith({ RATE_LIMIT_LOGIN_MAX: '2', TRUST_PROXY: 'true' });

    const comIp = (ip: string) =>
      app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: CREDENCIAL_ERRADA,
        headers: { 'x-forwarded-for': ip },
      });

    await comIp('203.0.113.1');
    await comIp('203.0.113.2');
    // Mesmo cenário do teste anterior, só que agora o header é confiado —
    // o terceiro IP é um cliente novo e tem que ser atendido. A DIFERENÇA
    // entre os dois testes é exatamente o que `TRUST_PROXY` controla.
    expect((await comIp('203.0.113.3')).statusCode).toBe(401);
    await app.close();
  });

  it('LIGADO, o app enxerga o IP do cliente e não o do proxy', async () => {
    const app = await buildWith({ TRUST_PROXY: 'true' });
    let visto: string | undefined;
    app.get('/__ip', async (request) => {
      visto = request.ip;
      return { ok: true };
    });

    await app.inject({ method: 'GET', url: '/__ip', headers: { 'x-forwarded-for': '198.51.100.7' } });

    expect(visto).toBe('198.51.100.7');
    await app.close();
  });
});
