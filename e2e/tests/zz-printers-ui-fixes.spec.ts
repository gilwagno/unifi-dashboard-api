import { expect, test, type Page } from '@playwright/test';
import { SEEDED_PRINTER_CLIENT } from '../e2e.config';
import { login, navigateTo } from './helpers';

/**
 * Rodada de VERIFICAÇÃO (papel verificador) — cada teste abaixo confirma, na
 * UI real renderizada pelo browser (stack e2e isolada: backend 3100, frontend
 * 5273, controller fake 8443), uma das 6 correções alegadas na página de
 * Impressoras. Nada aqui lê o código-fonte: só o texto/estado que o usuário
 * de fato vê.
 *
 * O nome do arquivo começa com `zz-` de propósito: o Playwright roda os
 * arquivos em ordem alfabética, então este é o ÚLTIMO — nenhum spec
 * pré-existente (clients/printers/ssh-rotation/wifi) vê o estado que este
 * cria, o que mantém a prova de "sem regressão" limpa. Ele parte da lista de
 * impressoras VAZIA, que é como printers.spec.ts (Fluxo B) a deixa.
 */
test.describe.configure({ mode: 'serial' });

/** MAC que o controller fake NÃO conhece — força `network.source: 'unknown'`. */
const UNKNOWN_MAC = 'aa:bb:cc:dd:ee:99';
const LOCAL_NAME_KNOWN = 'Cadastro Local Divergente';
const LOCAL_NAME_UNKNOWN = 'Impressora Fora do Controller';
const SNMP_COMMUNITY = 'public';

/** Mesmo localizador de card usado por printers.spec.ts (âncora por MAC). */
function printerCard(page: Page, mac: string) {
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

test('[bugs 1+2] rotulo "cadastro local" persistente e apelido "desconhecido" vs "sem apelido"', async ({ page }) => {
  await login(page);
  await navigateTo(page, 'Manutenção', 'Manutenção');
  await expect(page.getByText('Nenhuma impressora cadastrada.')).toBeVisible();

  await createPrinter(page, LOCAL_NAME_KNOWN, SEEDED_PRINTER_CLIENT.mac);
  await createPrinter(page, LOCAL_NAME_UNKNOWN, UNKNOWN_MAC);

  // --- BUG 1: os dois campos coexistem COM rótulo fixo (sem hover) ---
  const known = printerCard(page, SEEDED_PRINTER_CLIENT.mac);
  await expect(known.getByText('cadastro local', { exact: true })).toBeVisible();
  await expect(known).toContainText(LOCAL_NAME_KNOWN);
  await expect(known).toContainText('Apelido no UniFi:');

  // O apelido REAL no controller é diferente do nome do cadastro local — a
  // divergência que, sem rótulo, parecia dado corrompido.
  const aliasRow = known.locator('div', { hasText: 'Apelido no UniFi:' }).last();
  const aliasText = ((await aliasRow.innerText()) ?? '').trim();
  expect(aliasText).toContain('Apelido no UniFi:');

  // O invariante que importa é o VALOR exibido do apelido não ser o nome do
  // cadastro local (o bug original). O botão "Não confere — igualar a X"
  // cita esse nome de propósito, como ALVO da ação, e vive na mesma linha —
  // então ele é descontado antes da checagem, em vez de afrouxar a asserção
  // para "não contém em lugar nenhum", que deixaria de pegar o bug de novo.
  const botaoIgualar = aliasRow.getByRole('button', { name: /Não confere — igualar a/ });
  const textoBotao = (await botaoIgualar.count()) > 0 ? await botaoIgualar.innerText() : '';
  const aliasSemBotao = aliasText.replace(textoBotao, '').trim();
  expect(aliasSemBotao).not.toContain(LOCAL_NAME_KNOWN);
  await page.screenshot({ path: 'e2e/.verify-bug1-rotulo.png', fullPage: true });

  // --- BUG 2: source 'unknown' não pode AFIRMAR "sem apelido configurado" ---
  const unknown = printerCard(page, UNKNOWN_MAC);
  await expect(unknown).toContainText('Status de rede desconhecido');
  await expect(unknown).toContainText('apelido desconhecido');
  await expect(unknown).not.toContainText('sem apelido configurado');
  await expect(known).not.toContainText('apelido desconhecido');
});

test('[bug 3] acao em voo numa impressora nao e reabilitada por acao em outra', async ({ page }) => {
  await login(page);
  await navigateTo(page, 'Manutenção', 'Manutenção');

  const known = printerCard(page, SEEDED_PRINTER_CLIENT.mac);
  const unknown = printerCard(page, UNKNOWN_MAC);
  await expect(known).toBeVisible();
  await expect(unknown).toBeVisible();

  page.on('dialog', (dialog) => dialog.accept());

  // Trava o /reconnect da PRIMEIRA impressora em voo (a requisição sai de
  // verdade; só a RESPOSTA é retida) para poder agir na segunda no meio.
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/printers/*/reconnect', async (route) => {
    await gate;
    await route.continue();
  });

  await known.getByRole('button', { name: 'Reconectar' }).click();
  await expect(known.getByRole('button', { name: 'Reconectar' })).toBeDisabled();

  // Ação concorrente na OUTRA impressora: remove o cadastro dela (termina
  // antes, porque não está atrás do gate).
  await unknown.getByRole('button', { name: 'Remover' }).click();
  await expect(printerCard(page, UNKNOWN_MAC)).toHaveCount(0);

  // O ponto do bug: com `pendingId` global, o `finally` da remoção zerava o
  // estado e os botões da primeira impressora voltavam a ficar clicáveis com
  // a requisição dela ainda em voo.
  await expect(known.getByRole('button', { name: 'Reconectar' })).toBeDisabled();
  await expect(known.getByRole('button', { name: 'Reiniciar remotamente' })).toBeDisabled();
  await expect(known.getByRole('button', { name: 'Remover' })).toBeDisabled();
  await page.screenshot({ path: 'e2e/.verify-bug3-pending.png', fullPage: true });

  release();
  await expect(known.getByRole('button', { name: 'Reconectar' })).toBeEnabled();
});

test('[bug 4] trocar de impressora com credencial digitada pede confirmacao', async ({ page }) => {
  await login(page);
  await navigateTo(page, 'Manutenção', 'Manutenção');

  // A remoção do teste anterior deixou só uma impressora — recria a segunda.
  await createPrinter(page, LOCAL_NAME_UNKNOWN, UNKNOWN_MAC);

  const a = printerCard(page, SEEDED_PRINTER_CLIENT.mac);
  const b = printerCard(page, UNKNOWN_MAC);

  await a.getByRole('button', { name: 'Trocar senha de admin' }).click();
  const passwordA = a.getByPlaceholder('deixe em branco para gerar uma forte automaticamente');
  await expect(passwordA).toBeVisible();
  await passwordA.fill('CredencialA123');

  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss(); // recusa a troca de alvo
  });

  await b.getByRole('button', { name: 'Trocar senha de admin' }).click();
  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0]).toContain('outra impressora');

  // Recusado => o editor da A continua aberto COM o valor digitado, e nenhum
  // editor abriu na B.
  await expect(passwordA).toHaveValue('CredencialA123');
  await expect(b.getByPlaceholder('deixe em branco para gerar uma forte automaticamente')).toHaveCount(0);
  await page.screenshot({ path: 'e2e/.verify-bug4-confirm.png', fullPage: true });
});

test('[bugs 5+6] validacao de tamanho antes do confirm e erro descartavel', async ({ page }) => {
  await login(page);
  await navigateTo(page, 'Manutenção', 'Manutenção');

  const card = printerCard(page, SEEDED_PRINTER_CLIENT.mac);
  await card.getByRole('button', { name: 'Trocar senha de admin' }).click();
  const password = card.getByPlaceholder('deixe em branco para gerar uma forte automaticamente');
  await expect(password).toBeVisible();

  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });

  // --- BUG 6: senha curta não pode nem chegar ao confirm destrutivo ---
  await password.fill('abc');
  await card.getByRole('button', { name: 'Confirmar troca' }).click();
  await expect(card).toContainText('entre 8 e 18 caracteres');
  expect(dialogs).toHaveLength(0);
  await page.screenshot({ path: 'e2e/.verify-bug6-validacao.png', fullPage: true });

  // --- BUG 5: erro real (409 do backend, sem credencial cadastrada) some no
  // "Cancelar" e tem botão próprio de "Fechar" ---
  await password.fill('SenhaValida123');
  await card.getByRole('button', { name: 'Confirmar troca' }).click();
  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0]).toContain('credencial MESTRA');
  await expect(card).toContainText('Credencial do painel web não configurada');

  // O botão "Fechar" do próprio bloco de erro (não existia antes).
  await card.getByRole('button', { name: 'Fechar' }).click();
  await expect(card).not.toContainText('Credencial do painel web não configurada');

  // Reproduz o erro e fecha pelo "Cancelar" do editor (o caminho exato do bug).
  await password.fill('SenhaValida123');
  await card.getByRole('button', { name: 'Confirmar troca' }).click();
  await expect.poll(() => dialogs.length).toBe(2);
  await expect(card).toContainText('Credencial do painel web não configurada');
  await card.getByRole('button', { name: 'Cancelar' }).click();
  await expect(card).not.toContainText('Credencial do painel web não configurada');
  await page.screenshot({ path: 'e2e/.verify-bug5-erro.png', fullPage: true });
});

test('[sonda] editor de apelido pre-preenche vazio mesmo com apelido DESCONHECIDO', async ({ page }) => {
  await login(page);
  await navigateTo(page, 'Manutenção', 'Manutenção');

  const unknown = printerCard(page, UNKNOWN_MAC);
  await expect(unknown).toContainText('apelido desconhecido');

  // A linha admite não saber o apelido; o editor logo ao lado, um clique
  // depois, apresenta um campo VAZIO — a mesma afirmação falsa que o bug 2
  // corrigiu no texto, ainda presente na parte acionável.
  await unknown.getByRole('button', { name: 'Renomear apelido no UniFi' }).click();
  const input = unknown.locator('input');
  await expect(input).toHaveValue('');
  await page.screenshot({ path: 'e2e/.verify-sonda-alias-vazio.png', fullPage: true });

  // --- Sonda 2: o guard novo de troca de alvo do editor de APELIDO dispara
  // mesmo sem NADA digitado (o de senha de admin, no mesmo commit, só dispara
  // com rascunho preenchido) — pede confirmação de descarte de um rascunho
  // que não existe. ---
  const aliasDialogs: string[] = [];
  const collectAlias = async (dialog: import('@playwright/test').Dialog) => {
    aliasDialogs.push(dialog.message());
    await dialog.dismiss();
  };
  page.on('dialog', collectAlias);
  const known2 = printerCard(page, SEEDED_PRINTER_CLIENT.mac);
  await known2.getByRole('button', { name: 'Renomear apelido no UniFi' }).click();
  await expect.poll(() => aliasDialogs.length).toBe(1);
  expect(aliasDialogs[0]).toContain('descarta o que não foi salvo');
  page.off('dialog', collectAlias);

  // Limpeza: devolve a lista ao estado que os outros arquivos esperam.
  await unknown.getByRole('button', { name: 'Cancelar' }).click();
  page.on('dialog', (dialog) => dialog.accept());
  await unknown.getByRole('button', { name: 'Remover' }).click();
  await expect(printerCard(page, UNKNOWN_MAC)).toHaveCount(0);
  const known = printerCard(page, SEEDED_PRINTER_CLIENT.mac);
  await known.getByRole('button', { name: 'Remover' }).click();
  await expect(page.getByText('Nenhuma impressora cadastrada.')).toBeVisible();
});
