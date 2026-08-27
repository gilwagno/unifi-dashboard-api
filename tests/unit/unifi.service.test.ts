import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('unifiService / unifiFetch', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Confirmado contra um controller real: DELETE /wifi/broadcasts/{id} e
  // DELETE /networks/{id} respondem 200 (não 204) com corpo COMPLETAMENTE
  // VAZIO (content-type null, body length 0). Antes da correção, o
  // unifiFetch só tratava `res.status === 204` como "sem corpo" e tentava
  // `res.json()` num corpo vazio, o que lançava e virava um 500 genérico —
  // escondendo que a ação (deletar) na verdade tinha funcionado no
  // controller. Este teste cobre exatamente esse caso.
  it('deleteWifiBroadcast não lança quando o controller responde 200 com corpo vazio', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { unifiService } = await import('../../src/services/unifi.service.js');

    await expect(unifiService.deleteWifiBroadcast('wifi-1')).resolves.toBeUndefined();
  });

  it('deleteNetwork não lança quando o controller responde 200 com corpo vazio', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { unifiService } = await import('../../src/services/unifi.service.js');

    await expect(unifiService.deleteNetwork('net-1')).resolves.toBeUndefined();
  });

  it('continua tratando 204 sem corpo normalmente', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const { unifiService } = await import('../../src/services/unifi.service.js');

    await expect(unifiService.deleteNetwork('net-1')).resolves.toBeUndefined();
  });

  it('ainda faz parse de JSON normalmente quando o corpo não está vazio', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ id: 'net-1', name: 'IoT' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { unifiService } = await import('../../src/services/unifi.service.js');

    await expect(unifiService.listNetworks()).resolves.toEqual({ data: [{ id: 'net-1', name: 'IoT' }] });
  });
});
