import { expect, test } from '@playwright/test';
import { login, navigateTo } from './helpers';

/**
 * Onda 4 — e2e da CAMADA DE INTERFACE do Acesso Remoto.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ O QUE ESTE ARQUIVO **NÃO** PROVA — ler antes de tirar conclusão      │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * Este spec é COMPLEMENTAR à subtarefa 7, não a subtarefa 7. Ele verde não
 * significa que o acesso remoto funciona.
 *
 * As respostas de `/api/remote-access/*` são interceptadas com `page.route`
 * (mesmo recurso, e mesma ressalva registrada, dos specs U1/U4/U5 de
 * impressoras). Logo, o que roda de verdade aqui é: navegador real ->
 * frontend real -> **resposta simulada**. Não há Guacamole, não há `guacd`,
 * não há RDP, não há Windows.
 *
 * Em particular, os três pontos que a subtarefa 7 existe para provar seguem
 * ABERTOS depois deste arquivo passar:
 *
 *   1. a sessão RDP abrir de verdade contra uma estação física — tela
 *      renderizando no navegador, não "a conexão foi criada";
 *   2. o parâmetro custom `ad-object-guid` NÃO quebrar a sessão quando o
 *      `guacd` monta a conexão (o risco residual em aberto desde a subtarefa
 *      4; plano B pronto: mapa de correlação em SQLite);
 *   3. o passe-through ponta a ponta — credencial de domínio digitada no
 *      prompt do Guacamole autenticando na estação, com o Event ID 4624 do
 *      Windows registrando a PESSOA REAL.
 *
 * Nada disso é alcançável sem hardware. O que este arquivo trava é a camada
 * que não depende de hardware: a UI listar, abrir, AVISAR e encerrar.
 */

const GUID = 'c1c04940-1c5b-4cfa-a4f9-d05689e80045';
const TOKEN_FICTICIO = 'TOKEN-DE-TESTE-QUE-NAO-PODE-VAZAR';
// A URL do iframe é servida por uma rota interceptada: sem isso o navegador
// tentaria alcançar um Guacamole que não existe nesta suíte.
const URL_SESSAO = `http://127.0.0.1:1/guacamole-stub/#/client/MTA=?token=${TOKEN_FICTICIO}`;

const COMPUTADORES = [
  {
    name: 'EA-PC-TESTE01',
    objectGuid: GUID,
    dnsHostName: 'ea-pc-teste01.evokaudio.local',
    operatingSystem: 'Windows 11 Pro',
    enabled: true,
    hasAccess: true,
    connectionIdentifier: '10',
    activeSessions: 0,
  },
  {
    name: 'EA-PC-SEM-CONEXAO',
    objectGuid: 'df268070-22ab-4781-8465-7eb4bc790a2b',
    dnsHostName: 'ea-pc-sem-conexao.evokaudio.local',
    operatingSystem: 'Windows 10 Pro',
    enabled: true,
    hasAccess: false,
    connectionIdentifier: null,
    activeSessions: 0,
  },
];

test.describe('Acesso Remoto (camada de interface)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/remote-access/computers', async (route) => {
      await route.fulfill({ json: { data: COMPUTADORES } });
    });

    await page.route('**/api/remote-access/computers/*/session', async (route) => {
      await route.fulfill({
        json: {
          connectionIdentifier: '10',
          connectionName: 'EA-PC-TESTE01',
          guacamoleUser: 'dash-admin',
          url: URL_SESSAO,
        },
      });
    });

    // Stub do que o iframe carregaria. Serve para o teste exercitar a
    // montagem real do iframe sem depender de um Guacamole de verdade.
    await page.route('**/guacamole-stub/**', async (route) => {
      await route.fulfill({ contentType: 'text/html', body: '<p>tela remota (stub)</p>' });
    });

    await login(page);
    await navigateTo(page, 'Acesso Remoto', 'Acesso Remoto');
  });

  test('lista os computadores e distingue quem tem conexão configurada', async ({ page }) => {
    const comAcesso = page.locator('li').filter({ hasText: 'EA-PC-TESTE01' });
    const semAcesso = page.locator('li').filter({ hasText: 'EA-PC-SEM-CONEXAO' });

    await expect(comAcesso).toContainText('Disponível');
    await expect(semAcesso).toContainText('Sem acesso configurado');

    // Quem não tem conexão no Guacamole não pode ter o botão clicável — a
    // alternativa seria um erro 404 depois do clique, que é pior UX e ainda
    // gera uma linha de auditoria de um acesso que nunca poderia acontecer.
    await expect(semAcesso.getByRole('button', { name: 'Abrir sessão' })).toBeDisabled();
  });

  test('abrir sessão AVISA de forma destacada e encerrar desfaz tudo', async ({ page }) => {
    const linha = page.locator('li').filter({ hasText: 'EA-PC-TESTE01' });
    await linha.getByRole('button', { name: 'Abrir sessão' }).click();

    // --- o aviso ---------------------------------------------------------
    // Ver a tela de outra máquina não pode ser discreto. O aviso precisa
    // dizer QUAL máquina e SOB QUAL conta o acesso ficou registrado.
    const aviso = page.getByRole('alert');
    await expect(aviso).toContainText('Sessão remota ativa');
    await expect(aviso).toContainText('EA-PC-TESTE01');
    await expect(aviso).toContainText('dash-admin');

    // --- o iframe --------------------------------------------------------
    const iframe = page.locator('iframe');
    await expect(iframe).toHaveAttribute('src', URL_SESSAO);

    // O token vai no `src` do iframe (inevitável: o navegador é o cliente do
    // Guacamole), mas NÃO pode aparecer como texto da página nem na barra de
    // endereço — esta última iria para o histórico do navegador, que
    // sobrevive à sessão.
    await expect(page.locator('body')).not.toContainText(TOKEN_FICTICIO);
    expect(page.url()).not.toContain(TOKEN_FICTICIO);

    // --- encerrar --------------------------------------------------------
    await page.getByRole('button', { name: 'Encerrar sessão' }).click();

    await expect(page.locator('iframe')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    // E o token não sobrevive no DOM depois de encerrar.
    expect(await page.content()).not.toContain(TOKEN_FICTICIO);

    // A lista volta.
    await expect(page.locator('li').filter({ hasText: 'EA-PC-TESTE01' })).toBeVisible();
  });

  test('sessão já ativa numa máquina aparece na lista antes de qualquer clique', async ({ page }) => {
    // Transparência não depende de ter sido VOCÊ quem abriu: se alguém está
    // vendo a tela de uma máquina, a lista precisa dizer isso.
    await page.route('**/api/remote-access/computers', async (route) => {
      await route.fulfill({
        json: { data: [{ ...COMPUTADORES[0], activeSessions: 2 }] },
      });
    });
    await page.reload();

    await expect(page.locator('li').filter({ hasText: 'EA-PC-TESTE01' })).toContainText(
      '2 sessões ativas',
    );
  });
});
