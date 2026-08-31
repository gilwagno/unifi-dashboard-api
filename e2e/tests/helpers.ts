import { expect, request, type Page } from '@playwright/test';
import { DASHBOARD_PASSWORD, DASHBOARD_USER, FAKE_CONTROLLER_PORT } from '../e2e.config';

/**
 * Faz login pela UI de verdade (nada de injetar token no localStorage):
 * preenche o formulário de /login e clica em "Entrar", exatamente como o
 * usuário faria. Se o botão perdesse o handler, este helper falharia.
 */
export async function login(page: Page): Promise<void> {
  await page.goto('/login');

  await page.getByLabel('Usuário').fill(DASHBOARD_USER);
  await page.getByLabel('Senha').fill(DASHBOARD_PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();

  // O login redireciona para a visão geral — se as credenciais falhassem, a
  // página mostraria o erro e continuaríamos em /login.
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('header')).toContainText('Visão geral');
}

/**
 * Clica num item do menu lateral e espera o título no cabeçalho trocar.
 * O título da página é um <span> no <header> (não um heading), por isso a
 * asserção é feita com escopo no header — no menu lateral o mesmo texto
 * aparece como link.
 */
export async function navigateTo(page: Page, label: string, title: string): Promise<void> {
  await page.getByRole('link', { name: label }).click();
  await expect(page.locator('header')).toContainText(title);
}

/**
 * Lê o log de chamadas que o controller fake registrou. Serve para provar
 * que a ação da UI chegou de fato até o controller downstream (e não parou
 * numa atualização de estado só no frontend).
 */
export async function fakeControllerCalls(): Promise<Array<{ method: string; path: string }>> {
  const ctx = await request.newContext({ ignoreHTTPSErrors: true });
  try {
    const res = await ctx.get(`https://127.0.0.1:${FAKE_CONTROLLER_PORT}/__e2e/calls`);
    const body = await res.json();
    return body.data;
  } finally {
    await ctx.dispose();
  }
}
