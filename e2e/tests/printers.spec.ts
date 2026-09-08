import { expect, test } from '@playwright/test';
import { SEEDED_PRINTER_CLIENT } from '../e2e.config';
import { fakeControllerCalls, login, navigateTo } from './helpers';

const PRINTER_NAME = 'Impressora E2E';
const PRINTER_NAME_EDITED = 'Impressora E2E (revisada)';
const PRINTER_ALIAS = 'Impressora E2E — Apelido novo';
const SNMP_COMMUNITY = 'public';

// Os dois fluxos deste arquivo dependem um do outro DE PROPÓSITO (o B mexe e
// remove a impressora que o A cadastra) — é o mesmo desenho de "cria e depois
// desfaz" já usado em clients.spec.ts/wifi.spec.ts, só que dividido em dois
// testes para separar as duas telas de ação. Declarar `serial` torna essa
// dependência explícita para o Playwright: a ordem fica garantida mesmo que
// `workers`/`fullyParallel` mudem no futuro, e se o Fluxo A falhar o B é
// PULADO em vez de falhar em cascata com um erro que não aponta pra causa.
test.describe.configure({ mode: 'serial' });

/**
 * Localiza o card da impressora pelo MAC. O card é o `<div>` de topo de cada
 * item da lista (classe `rounded-xl` exclusiva desse nível — o único outro
 * lugar que usa a mesma classe é o placeholder "Nenhuma impressora
 * cadastrada.", que nunca contém um MAC). Âncora por MAC (e não por nome)
 * porque o próprio teste edita o nome no meio do fluxo.
 */
function printerCard(page: import('@playwright/test').Page, mac: string) {
  return page.locator('div.rounded-xl').filter({ hasText: mac });
}

/**
 * Fluxo A — login -> cadastra uma impressora nova (reaproveitando o MAC do
 * cliente semeado no controller fake, o que também exercita o merge de
 * status de rede de verdade) -> confere consumíveis sem leitura SNMP (não
 * existe hardware real no e2e, então "nunca coletado" É o resultado
 * esperado) -> renomeia o apelido no UniFi -> edita o cadastro.
 *
 * A remoção fica no Fluxo B (junto do reconnect); os dois rodam em série (ver
 * `test.describe.configure` acima), mas a divisão evita acoplar os dois
 * testes ao MESMO estado do React de ponta a ponta. O cadastro que sobra
 * entre um teste e outro vive no SQLite de e2e, apagado no início de cada run
 * (ver e2e/reset-printers-db.mjs).
 */
test('cadastra uma impressora, confere consumíveis, renomeia o apelido e edita', async ({ page }) => {
  await login(page);
  await navigateTo(page, 'Manutenção', 'Manutenção');

  await expect(page.getByText('Nenhuma impressora cadastrada.')).toBeVisible();

  // --- Cadastrar ---
  await page.getByRole('button', { name: 'Nova impressora' }).click();

  await page.getByPlaceholder('ex: HPLaserMFP135w').fill(PRINTER_NAME);
  await page.getByPlaceholder('aa:bb:cc:dd:ee:ff').fill(SEEDED_PRINTER_CLIENT.mac);
  // Versão SNMP já vem em v2c por padrão (EMPTY_FORM) — só a community.
  await page.getByPlaceholder('ex: public').fill(SNMP_COMMUNITY);
  await page.getByRole('button', { name: 'Cadastrar impressora' }).click();

  const card = printerCard(page, SEEDED_PRINTER_CLIENT.mac);
  await expect(card).toBeVisible();
  await expect(card).toContainText(PRINTER_NAME);

  // Merge de status de rede de verdade: o MAC bate com o cliente semeado no
  // controller fake, então o badge não pode cair no fallback "desconhecido".
  await expect(card).not.toContainText('Status de rede desconhecido');

  // --- Consumíveis: sem leitura SNMP real, "nunca coletado" é o esperado ---
  await card.getByRole('button', { name: 'Ver consumíveis' }).click();
  await expect(card).toContainText('nunca coletado');
  await expect(card).toContainText('Nenhum suprimento coletado ainda.');

  // --- Renomear o Apelido no UniFi (achado 8 do CLAUDE.md, rota genérica
  // /clients/:mac/alias) — prova que a ação atravessou backend -> controller
  // pela contagem de chamadas PUT em rest/user, não só o estado local. ---
  const beforeAlias = await fakeControllerCalls();
  const putsBefore = beforeAlias.filter((c) => c.method === 'PUT' && c.path.includes('/rest/user/')).length;

  await card.getByRole('button', { name: 'Renomear apelido no UniFi' }).click();
  await card.locator('input').fill(PRINTER_ALIAS);
  await card.getByRole('button', { name: 'Salvar' }).click();

  // O formulário de alias fecha (volta a mostrar o botão de renomear) só
  // depois que a chamada termina com sucesso.
  await expect(card.getByRole('button', { name: 'Renomear apelido no UniFi' })).toBeVisible();

  const afterAlias = await fakeControllerCalls();
  const putsAfter = afterAlias.filter((c) => c.method === 'PUT' && c.path.includes('/rest/user/')).length;
  expect(putsAfter - putsBefore).toBe(1);

  // Contar o PUT prova que a chamada SAIU, não que ela fez a coisa certa: o
  // controller ignora em silêncio um campo desconhecido, então mandar
  // `hostname` (só-leitura) no lugar de `name` produziria exatamente a mesma
  // contagem. A prova real é o efeito — o apelido novo aparecendo na lista de
  // clientes, que é lida do controller a cada carregamento da tela.
  await navigateTo(page, 'Clientes', 'Clientes');
  const clientRow = page.getByText(SEEDED_PRINTER_CLIENT.mac, { exact: true }).locator('..');
  await expect(clientRow).toContainText(PRINTER_ALIAS);
  await navigateTo(page, 'Manutenção', 'Manutenção');

  // --- Editar o cadastro ---
  await card.getByRole('button', { name: 'Editar' }).click();
  const nameInput = page.getByPlaceholder('ex: HPLaserMFP135w');
  await nameInput.fill('');
  await nameInput.fill(PRINTER_NAME_EDITED);
  await page.getByRole('button', { name: 'Salvar alterações' }).click();

  await expect(card).toContainText(PRINTER_NAME_EDITED);
});

/**
 * Fluxo B — reconecta a impressora cadastrada no Fluxo A (bloqueia +
 * desbloqueia via controller, mesmo caminho do fluxo de clientes) e depois
 * remove o cadastro. Os dois `window.confirm` nativos (reconectar / remover)
 * são tratados pelo mesmo handler de `dialog`, registrado uma única vez.
 */
test('reconecta e remove a impressora cadastrada', async ({ page }) => {
  await login(page);
  await navigateTo(page, 'Manutenção', 'Manutenção');

  const card = printerCard(page, SEEDED_PRINTER_CLIENT.mac);
  await expect(card).toBeVisible();
  await expect(card).toContainText(PRINTER_NAME_EDITED);

  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });

  // --- Reconectar (bloqueia + desbloqueia no controller) ---
  const beforeReconnect = await fakeControllerCalls();
  const stamgrBefore = beforeReconnect.filter((c) => c.path.endsWith('/cmd/stamgr')).length;

  await card.getByRole('button', { name: 'Reconectar' }).click();
  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0]).toContain('Reconectar');

  await expect(card.getByRole('button', { name: 'Reconectar' })).toBeEnabled();

  const afterReconnect = await fakeControllerCalls();
  const stamgrAfter = afterReconnect.filter((c) => c.path.endsWith('/cmd/stamgr')).length;
  expect(stamgrAfter - stamgrBefore).toBe(2); // block-sta + unblock-sta

  // --- Remover ---
  await card.getByRole('button', { name: 'Remover' }).click();
  await expect.poll(() => dialogs.length).toBe(2);
  expect(dialogs[1]).toContain(PRINTER_NAME_EDITED);

  await expect(printerCard(page, SEEDED_PRINTER_CLIENT.mac)).toHaveCount(0);
  await expect(page.getByText('Nenhuma impressora cadastrada.')).toBeVisible();
});
