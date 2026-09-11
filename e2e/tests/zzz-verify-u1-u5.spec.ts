import { expect, test, type Locator, type Page } from '@playwright/test';
import { SEEDED_PRINTER_CLIENT } from '../e2e.config';
import { login, navigateTo } from './helpers';

/**
 * VERIFICADOR CEGO — U1..U5 dos commits 97b1d19 / eb3379a / 811f053.
 *
 * Tudo aqui roda contra a stack e2e isolada (backend 3100, frontend 5273,
 * controller fake 8443). Nenhuma porta de desenvolvimento (3000/5173), nenhum
 * banco de produção, nenhuma impressora real é tocada.
 *
 * Prefixo `zzz-` para rodar por último (ordem alfabética de arquivos) e não
 * contaminar nenhum spec pré-existente. Cada teste começa limpando a lista de
 * impressoras pela própria UI, então não depende do que os arquivos
 * anteriores deixaram.
 */
test.describe.configure({ mode: 'serial' });

const UNKNOWN_MAC = 'aa:bb:cc:dd:ee:77';
const SNMP_COMMUNITY = 'public';

function printerCard(page: Page, mac: string): Locator {
  return page.locator('div.rounded-xl').filter({ hasText: mac });
}

async function createPrinter(page: Page, name: string, mac: string) {
  await page.getByRole('button', { name: 'Nova impressora' }).click();
  await page.getByPlaceholder('ex: HPLaserMFP135w').fill(name);
  await page.getByPlaceholder('aa:bb:cc:dd:ee:ff').fill(mac);
  await page.getByPlaceholder('ex: public').fill(SNMP_COMMUNITY);
  await page.getByRole('button', { name: 'Cadastrar impressora' }).click();
  await expect(printerCard(page, mac)).toBeVisible();
}

/**
 * Handler ÚNICO de diálogo por teste (o Playwright não deixa dois handlers
 * tratarem o mesmo `confirm`). `mode` decide aceitar ou cancelar, e as
 * mensagens ficam registradas para asserção.
 */
function dialogController(page: Page) {
  const state = { mode: 'accept' as 'accept' | 'dismiss', messages: [] as string[] };
  page.on('dialog', async (d) => {
    state.messages.push(d.message());
    if (state.mode === 'accept') await d.accept();
    else await d.dismiss();
  });
  return state;
}

/** Remove toda impressora cadastrada pela UI, para cada teste partir do zero. */
async function wipePrinters(page: Page) {
  // Espera a lista TERMINAR de carregar antes de contar botoes — enquanto
  // `printers === null` a pagina mostra "Carregando..." e zero botoes
  // "Remover", o que faria o laco abaixo sair achando que ja esta vazia.
  await expect(page.getByText('Carregando…')).toHaveCount(0);
  for (;;) {
    const remove = page.getByRole('button', { name: 'Remover' }).first();
    if ((await page.getByRole('button', { name: 'Remover' }).count()) === 0) break;
    // Remover pede confirmacao (window.confirm) — sem um handler proprio o
    // Playwright DISPENSA o dialogo por padrao e a remocao nunca acontece.
    page.once('dialog', (d) => void d.accept());
    await remove.click();
    await page.waitForTimeout(300);
  }
  await expect(page.getByText('Nenhuma impressora cadastrada.')).toBeVisible();
}

/** Corpo de /consumables com um toner e duas peças do ADF, todas MEDIDAS. */
function consumablesBody(printerId: string, tonerPct: number, tonerStatus: 'ok' | 'low') {
  return {
    printerId,
    collectedAt: '2026-09-10T12:00:00.000Z',
    pageCount: 1234,
    lowThresholdPct: 20,
    supplies: [
      { name: 'Black Toner', serialNumber: 'CRUM-VERIF-1', levelPercent: tonerPct, status: tonerStatus },
      { name: 'ADF Roller', serialNumber: null, levelPercent: 100, status: 'ok' },
      { name: 'ADF Rubber Pad', serialNumber: null, levelPercent: 100, status: 'ok' },
    ],
  };
}

// ---------------------------------------------------------------------------
// U2 — botão "Não confere — igualar a X"
// ---------------------------------------------------------------------------
test('[U2] "Não confere" só aparece com divergência real, pede confirmação e some depois', async ({ page }) => {
  await login(page);
  await navigateTo(page, 'Manutenção', 'Manutenção');
  await wipePrinters(page);

  await createPrinter(page, 'Cadastro VERIF A', SEEDED_PRINTER_CLIENT.mac);
  await createPrinter(page, 'Cadastro VERIF B', UNKNOWN_MAC);

  const known = printerCard(page, SEEDED_PRINTER_CLIENT.mac);
  const unknown = printerCard(page, UNKNOWN_MAC);

  const alignBtn = known.getByRole('button', { name: /Não confere — igualar a/ });
  await expect(alignBtn).toBeVisible();
  await expect(alignBtn).toContainText('Cadastro VERIF A');

  // Status de rede desconhecido -> NÃO propõe igualar (alias:null = "não sabemos").
  await expect(unknown).toContainText('Status de rede desconhecido');
  await expect(unknown).toContainText('apelido desconhecido');
  await expect(unknown.getByRole('button', { name: /Não confere — igualar a/ })).toHaveCount(0);

  // --- Cancelar a confirmação não muda nada ---
  const aliasBefore = (await known.innerText()).includes('Cadastro VERIF A');
  expect(aliasBefore).toBe(true); // o nome do cadastro está na tela
  let dialogMsg = '';
  page.once('dialog', async (d) => {
    dialogMsg = d.message();
    await d.dismiss();
  });
  await alignBtn.click();
  await expect.poll(() => dialogMsg).toContain('Renomear o Apelido no UniFi');
  await expect(alignBtn).toBeVisible(); // continua divergente

  // --- Aceitar: alinha e o botão some ---
  page.once('dialog', (d) => void d.accept());
  await alignBtn.click();
  await expect(known.getByRole('button', { name: /Não confere — igualar a/ })).toHaveCount(0);
  await expect(known).toContainText('Cadastro VERIF A');
});

// ---------------------------------------------------------------------------
// U3 — renomear apelido escreve nos DOIS sistemas; falha da 2ª = sucesso parcial
// ---------------------------------------------------------------------------
test('[U3] renomear o apelido também renomeia o cadastro, e a 2ª escrita falhando vira sucesso PARCIAL', async ({
  page,
}) => {
  await login(page);
  await navigateTo(page, 'Manutenção', 'Manutenção');
  await wipePrinters(page);
  await createPrinter(page, 'Nome Antigo VERIF', SEEDED_PRINTER_CLIENT.mac);

  const card = printerCard(page, SEEDED_PRINTER_CLIENT.mac);

  // --- Caminho feliz: os dois campos passam a bater ---
  await card.getByRole('button', { name: 'Renomear apelido no UniFi' }).click();
  await card.locator('input').fill('Nome Unificado VERIF');
  await card.getByRole('button', { name: 'Salvar' }).click();

  await expect(page.getByText(/Nome atualizado para "Nome Unificado VERIF" no UniFi e no cadastro local/)).toBeVisible();
  // O nome de CIMA (cadastro local) mudou junto — este é o coração do U3.
  await expect(card.locator('span').filter({ hasText: /^Nome Unificado VERIF$/ }).first()).toBeVisible();
  await expect(card).not.toContainText('Nome Antigo VERIF');
  await expect(card.getByRole('button', { name: /Não confere — igualar a/ })).toHaveCount(0);

  // Chegou de verdade no controller (a lista de Clientes é lida do controller).
  await navigateTo(page, 'Clientes', 'Clientes');
  const clientRow = page.getByText(SEEDED_PRINTER_CLIENT.mac, { exact: true }).locator('..');
  await expect(clientRow).toContainText('Nome Unificado VERIF');
  await navigateTo(page, 'Manutenção', 'Manutenção');

  // --- Caminho de falha da SEGUNDA escrita (PATCH /printers/:id) ---
  await page.route('**/api/printers/*', async (route) => {
    if (route.request().method() === 'PATCH') {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'falha simulada no cadastro local' }),
      });
      return;
    }
    await route.continue();
  });

  const card2 = printerCard(page, SEEDED_PRINTER_CLIENT.mac);
  await card2.getByRole('button', { name: 'Renomear apelido no UniFi' }).click();
  await card2.locator('input').fill('Apelido Parcial VERIF');
  await card2.getByRole('button', { name: 'Salvar' }).click();

  // Relata PARCIAL, nunca "atualizado".
  await expect(page.getByText(/mas o nome do cadastro local NÃO foi alterado/)).toBeVisible();
  await expect(page.getByText(/Nome atualizado para "Apelido Parcial VERIF" no UniFi e no cadastro local/)).toHaveCount(
    0,
  );
  // E o estado real bate com o relato: apelido novo, cadastro velho.
  await expect(card2).toContainText('Nome Unificado VERIF'); // cadastro local intacto
  await expect(card2).toContainText('Apelido Parcial VERIF'); // apelido no UniFi já mudou
  await page.unroute('**/api/printers/*');
});

// ---------------------------------------------------------------------------
// U1 — ADF fora do medidor compacto, dentro do detalhe expandido
// ---------------------------------------------------------------------------
test('[U1] o medidor compacto ignora peças do ADF; o detalhe expandido continua mostrando', async ({ page }) => {
  await login(page);
  await navigateTo(page, 'Manutenção', 'Manutenção');
  await wipePrinters(page);
  await createPrinter(page, 'Toner VERIF', SEEDED_PRINTER_CLIENT.mac);

  await page.route('**/api/printers/*/consumables', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(consumablesBody(id, 0, 'low')),
    });
  });
  await page.reload();

  const card = printerCard(page, SEEDED_PRINTER_CLIENT.mac);
  const gauge = card.locator('[title="Níveis de suprimentos"]');
  await expect(gauge).toBeVisible();

  // Um único tubo (o toner). Se o ADF entrasse, seriam três.
  const tubes = gauge.locator('> div');
  await expect(tubes).toHaveCount(1);
  await expect(gauge).toContainText('0%');
  await expect(gauge).not.toContainText('100%');
  const tubeTitle = await tubes.first().getAttribute('title');
  expect(tubeTitle).toContain('Black Toner');

  // Detalhe expandido: os três aparecem, ADF incluído.
  await card.getByRole('button', { name: 'Ver consumíveis' }).click();
  await expect(card).toContainText('ADF Roller');
  await expect(card).toContainText('ADF Rubber Pad');
  await expect(card).toContainText('Black Toner');
});

// ---------------------------------------------------------------------------
// U5 — painel de saúde da frota + medidor atualizando sozinho no polling
// ---------------------------------------------------------------------------
test('[U5] "Precisa de atenção" nomeia a impressora e o motivo, e o medidor atualiza sozinho no polling', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await login(page);
  await navigateTo(page, 'Manutenção', 'Manutenção');
  await wipePrinters(page);
  await createPrinter(page, 'Frota VERIF', SEEDED_PRINTER_CLIENT.mac);

  let tonerPct = 5;
  await page.route('**/api/printers/*/consumables', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(consumablesBody(id, tonerPct, tonerPct < 20 ? 'low' : 'ok')),
    });
  });
  await page.reload();

  const card = printerCard(page, SEEDED_PRINTER_CLIENT.mac);
  const gauge = card.locator('[title="Níveis de suprimentos"]');
  await expect(gauge).toContainText('5%');

  // Painel de saúde: nome + motivo, não só um número.
  // O StatCard inteiro (label + valor + trend). Filtrar `div` cru e pegar
  // `.last()` resolvia para o <div> interno que so contem o LABEL, sem o
  // texto de detalhe — falso negativo do localizador, nao da feature.
  const attention = page.locator('div.rounded-xl').filter({ hasText: 'Precisa de atenção' }).last();
  await expect(attention).toContainText('Frota VERIF');
  await expect(attention).toContainText('toner baixo');

  // Polling (60s): o poller do backend "coletou" um valor novo; a tela tem que
  // refletir sozinha, sem F5 e sem clique.
  tonerPct = 73;
  await expect(gauge).toContainText('73%', { timeout: 120_000 });
  await expect(attention).toContainText('tudo em dia');
});

// ---------------------------------------------------------------------------
// U4 — layout do card em 2 larguras
// ---------------------------------------------------------------------------
test('[U4] layout do card: 2 colunas, ações em 2 grupos, sem estouro horizontal', async ({ page }) => {
  await login(page);
  await navigateTo(page, 'Manutenção', 'Manutenção');
  await wipePrinters(page);
  await createPrinter(page, 'Impressora com um nome bem longo pra estressar o layout do card', SEEDED_PRINTER_CLIENT.mac);
  await createPrinter(page, 'HP', UNKNOWN_MAC);

  await page.route('**/api/printers/*/consumables', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(consumablesBody(id, 8, 'low')),
    });
  });
  await page.reload();

  for (const width of [1280, 1600]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(400);

    const card = printerCard(page, SEEDED_PRINTER_CLIENT.mac);
    await expect(card).toBeVisible();

    // 1) Sem barra de rolagem horizontal na página.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `overflow horizontal em ${width}px`).toBeLessThanOrEqual(0);

    // 2) Todo botão do card está DENTRO do card (nada órfão/vazando).
    const cardBox = (await card.boundingBox())!;
    const names = [
      'Ver consumíveis',
      'Reconectar',
      'Reiniciar remotamente',
      'Trocar senha de admin',
      'Editar',
      'Remover',
    ];
    for (const n of names) {
      const b = (await card.getByRole('button', { name: n, exact: true }).boundingBox())!;
      expect(b, `${n} sem box em ${width}px`).toBeTruthy();
      expect(b.x, `${n} vaza à esquerda em ${width}px`).toBeGreaterThanOrEqual(cardBox.x - 1);
      expect(b.x + b.width, `${n} vaza à direita em ${width}px`).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
    }

    // 3) Os dois grupos de ação estão EMPILHADOS (linhas distintas), não na
    //    mesma fileira: o rodapé do grupo de operação fica acima do topo do
    //    grupo de administração.
    const ops = (await card.getByRole('button', { name: 'Ver consumíveis' }).boundingBox())!;
    const admin = (await card.getByRole('button', { name: 'Editar', exact: true }).boundingBox())!;
    expect(ops.y + ops.height, `grupos não empilhados em ${width}px`).toBeLessThanOrEqual(admin.y + 1);

    // 4) Identidade (nome/MAC) e coluna de ações não se sobrepõem.
    const mac = (await card.getByText(SEEDED_PRINTER_CLIENT.mac).boundingBox())!;
    expect(mac.x + mac.width, `identidade invade as ações em ${width}px`).toBeLessThanOrEqual(ops.x + 1);

    // 5) Badge de rede e medidor moraram na coluna da esquerda, abaixo do MAC.
    const gauge = (await card.locator('[title="Níveis de suprimentos"]').boundingBox())!;
    expect(gauge.y, `medidor não ficou abaixo do MAC em ${width}px`).toBeGreaterThanOrEqual(mac.y);
    expect(gauge.x, `medidor não ficou na coluna da esquerda em ${width}px`).toBeLessThan(ops.x);

    await page.screenshot({ path: `e2e/.verif-layout-${width}.png`, fullPage: true });
  }
});
