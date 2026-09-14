import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

// Onda de Robustez, item 3 — headers de segurança (@fastify/helmet).
//
// Este backend é uma API PURA: não serve HTML nem estático (não há
// `@fastify/static` registrado; o Dockerfile publica só o `dist/` do
// backend e o frontend Vite é deployado à parte). Por isso o CSP aqui é o
// mais restritivo possível, e a armadilha clássica do helmet — o CSP
// padrão quebrar o front por script/estilo inline do Vite/Tailwind — não
// se aplica: não há front nesta resposta para quebrar.
//
// O teste que importa não é "o header existe". É o par header-presente +
// **o CORS continua funcionando**, porque os dois plugins discordam por
// padrão e a discordância só aparece no navegador.

async function app() {
  return buildApp();
}

describe('headers de segurança', () => {
  it('responde com Content-Security-Policy restritivo', async () => {
    const a = await app();
    const res = await a.inject({ method: 'POST', url: '/auth/login', payload: {} });

    const csp = res.headers['content-security-policy'];
    expect(csp).toBeDefined();
    // `default-src 'none'` é a afirmação verdadeira sobre um corpo JSON:
    // esta resposta não deve carregar recurso nenhum.
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    await a.close();
  });

  it('bloqueia sniffing de MIME e enquadramento em iframe', async () => {
    const a = await app();
    const res = await a.inject({ method: 'POST', url: '/auth/login', payload: {} });

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // O `frame-ancestors 'none'` do CSP acima é a versão moderna; este é o
    // legado que navegadores antigos ainda respeitam.
    expect(res.headers['x-frame-options']).toBeDefined();
    await a.close();
  });

  it('não anuncia o Fastify no header X-Powered-By', async () => {
    const a = await app();
    const res = await a.inject({ method: 'POST', url: '/auth/login', payload: {} });
    expect(res.headers['x-powered-by']).toBeUndefined();
    await a.close();
  });

  // O ACHADO deste item, e a razão de este teste existir.
  //
  // O default do helmet para `Cross-Origin-Resource-Policy` é `same-origin`
  // — e isso CONTRADIZ o `cors` registrado com `origin: true` (reflete
  // qualquer origem), que é justamente o deploy deste projeto: frontend
  // numa origem, API em outra. Com o default, o navegador BLOQUEIA a
  // resposta mesmo com o CORS liberado, e o sintoma chega ao usuário como
  // "falha de rede" sem explicação — o tipo de quebra que passa em todo
  // teste que só verifica se o header existe.
  it('NÃO quebra o CORS: a resposta continua utilizável de outra origem', async () => {
    const a = await app();
    const res = await a.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {},
      headers: { origin: 'http://localhost:5173' },
    });

    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    await a.close();
  });

  it('preflight OPTIONS de outra origem continua passando', async () => {
    const a = await app();
    const res = await a.inject({
      method: 'OPTIONS',
      url: '/auth/login',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });

    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    await a.close();
  });

  // HSTS mandado por um app que atende HTTP faz o navegador passar a exigir
  // HTTPS daquele host — e recusar o próprio app depois, sem forma fácil de
  // desfazer do lado do usuário. Quem termina o TLS (o proxy) é quem deve
  // emitir esse header.
  it('NÃO emite HSTS — quem termina o TLS é o proxy', async () => {
    const a = await app();
    const res = await a.inject({ method: 'POST', url: '/auth/login', payload: {} });
    expect(res.headers['strict-transport-security']).toBeUndefined();
    await a.close();
  });

  it('os headers valem para rotas autenticadas, não só para o login', async () => {
    const a = await app();
    const res = await a.inject({ method: 'GET', url: '/clients' });

    expect(res.statusCode).toBe(401);
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    await a.close();
  });
});
