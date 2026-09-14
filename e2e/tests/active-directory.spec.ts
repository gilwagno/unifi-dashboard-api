import { expect, test } from '@playwright/test';
import { SEEDED_AD_COMPUTER, SEEDED_AD_DC, SEEDED_AD_NESTED_GROUP, SEEDED_AD_USER } from '../e2e.config';
import { login, navigateTo } from './helpers';

/**
 * Onda 3, subtarefa 8 — os três fluxos do escopo funcional do módulo de
 * Active Directory, ponta a ponta pela UI real.
 *
 * A stack é toda real, menos o diretório: navegador de verdade -> frontend
 * Vite de verdade -> backend Fastify de verdade -> `ldapts` de verdade ->
 * **fake-ldap-server** falando o protocolo LDAP por socket TLS. Nunca
 * contra o Active Directory real, mesma regra já usada no e2e do núcleo
 * UniFi com o controller fake: um e2e automatizado não pode depender de (e
 * muito menos escrever em) infraestrutura de produção.
 *
 * O diretório do fake é recriado a cada boot do processo, mas a run inteira
 * compartilha UM processo (`workers: 1`), então os fluxos que MUTAM estado
 * ficam em `describe.serial` e cada um desfaz o que fez.
 */

test.describe('Active Directory', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await navigateTo(page, 'Active Directory', 'Active Directory');
  });

  test.describe.configure({ mode: 'serial' });

  // --- Fluxo 1: usuário ---------------------------------------------------
  test('lista usuários do diretório e desabilita/reabilita uma conta', async ({ page }) => {
    const linha = page.locator('li').filter({ hasText: SEEDED_AD_USER.displayName });
    await expect(linha).toContainText('Ativa');

    await linha.getByRole('button', { name: 'Desabilitar' }).click();

    // A asserção é sobre o EFEITO relido do diretório (a página recarrega a
    // lista após a ação), não sobre a mensagem de sucesso — uma mensagem de
    // sucesso pode ser escrita sem que nada tenha acontecido no LDAP.
    await expect(linha).toContainText('Desabilitada');

    await linha.getByRole('button', { name: 'Habilitar' }).click();
    await expect(linha).toContainText('Ativa');
  });

  test('busca filtra os usuários pelo termo', async ({ page }) => {
    await page.getByLabel(/Buscar por nome, login ou e-mail/).fill('jsilva');
    await expect(page.locator('li').filter({ hasText: SEEDED_AD_USER.displayName })).toBeVisible();

    await page.getByLabel(/Buscar por nome, login ou e-mail/).fill('naoexiste-xyz');
    await expect(page.getByText('Nenhum usuário encontrado.')).toBeVisible();
  });

  // --- Fluxo 2: grupo, com a distinção direta vs herdada -------------------
  //
  // O teste central desta suíte. Medido contra o AD real em 2026-09-14: o
  // grupo de acesso à rede tinha 20 membros diretos, 12 dos quais eram
  // GRUPOS inteiros, carregando 61 pessoas por herança. O dashboard
  // revogaria 8 de 69 — os outros 61 veriam "revogado com sucesso" e
  // continuariam conectados. Se esta tela mostrar uma lista uniforme de
  // "membros", o bug de produção continua existindo na prática.
  test('grupo com aninhamento distingue membro direto de acesso herdado e avisa', async ({ page }) => {
    await page.getByRole('button', { name: 'Grupos' }).click();

    // A busca EXIGE um termo: sem filtro o diretório devolve todos os grupos
    // do domínio, inclusive os administrativos.
    await expect(page.getByRole('button', { name: 'Buscar' })).toBeDisabled();

    await page.getByLabel('Buscar grupo').fill(SEEDED_AD_NESTED_GROUP);
    await page.getByRole('button', { name: 'Buscar' }).click();
    await page.getByRole('button', { name: 'Ver membros' }).click();

    // Os tipos aparecem com rótulos DIFERENTES — é isso que impede o
    // operador de achar que revogou quem entrou por herança. A asserção é
    // por CONTAGEM, não por "existe pelo menos um": se todos os membros
    // fossem rotulados igual, um `toBeVisible()` continuaria passando.
    // `exact: true` importa: o `getByText` do Playwright faz match de
    // SUBSTRING e CASE-INSENSITIVE por padrão, então o rodapé
    // ("1 não resolvido(s)") era contado junto com o selo e a contagem dava
    // 2. O selo é que está sendo verificado aqui, não o resumo.
    await expect(page.getByText('Membro direto', { exact: true })).toHaveCount(2);
    await expect(page.getByText('Grupo · acesso herdado', { exact: true })).toHaveCount(1);
    await expect(page.getByText('Não resolvido', { exact: true })).toHaveCount(1);

    // E o nome com vírgula ESCAPADA no DN chega inteiro na tela.
    await expect(page.getByText('Souza, Maria')).toBeVisible();

    await expect(page.getByRole('alert')).toContainText('não revoga esse acesso herdado');
  });

  test('grupo SEM aninhamento não mostra o aviso', async ({ page }) => {
    await page.getByRole('button', { name: 'Grupos' }).click();
    await page.getByLabel('Buscar grupo').fill('Financeiro');
    await page.getByRole('button', { name: 'Buscar' }).click();
    await page.getByRole('button', { name: 'Ver membros' }).click();

    await expect(page.getByText('Membro direto', { exact: true })).toBeVisible();
    // Alerta em tudo vira ruído e ninguém lê no caso que importa.
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  // --- Fluxo 3: computadores ----------------------------------------------
  test('lista computadores e marca o controlador de domínio', async ({ page }) => {
    await page.getByRole('button', { name: 'Computadores' }).click();

    await expect(page.locator('li').filter({ hasText: SEEDED_AD_COMPUTER })).toBeVisible();

    const dc = page.locator('li').filter({ hasText: SEEDED_AD_DC });
    await expect(dc).toContainText('Controlador de domínio');
  });

  test('desabilitar conta de computador exige confirmação — cancelar não altera nada', async ({ page }) => {
    await page.getByRole('button', { name: 'Computadores' }).click();
    const linha = page.locator('li').filter({ hasText: SEEDED_AD_COMPUTER });
    await expect(linha).toContainText('Ativa');

    page.once('dialog', (d) => void d.dismiss());
    await linha.getByRole('button', { name: 'Desabilitar conta' }).click();

    // Continua ativa: a confirmação recusada não pode ter chegado ao LDAP.
    await expect(linha).toContainText('Ativa');
  });

  test('desabilitar e reabilitar a conta de um computador de verdade', async ({ page }) => {
    await page.getByRole('button', { name: 'Computadores' }).click();
    const linha = page.locator('li').filter({ hasText: SEEDED_AD_COMPUTER });

    page.once('dialog', (d) => void d.accept());
    await linha.getByRole('button', { name: 'Desabilitar conta' }).click();
    await expect(linha).toContainText('Desabilitada');

    // Habilitar NÃO pede confirmação (não é destrutivo) — se pedisse, este
    // clique ficaria pendurado num diálogo que ninguém trata e o teste
    // falharia por timeout.
    await linha.getByRole('button', { name: 'Habilitar conta' }).click();
    await expect(linha).toContainText('Ativa');
  });
});
