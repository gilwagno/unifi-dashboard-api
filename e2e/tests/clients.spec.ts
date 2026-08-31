import { expect, test } from '@playwright/test';
import { SEEDED_CLIENT } from '../e2e.config';
import { fakeControllerCalls, login, navigateTo } from './helpers';

/**
 * Fluxo 1 — login -> bloquear cliente -> desbloquear cliente.
 *
 * Tudo pela UI: o teste nunca chama a API do backend diretamente. O estado
 * exibido ("Ativo"/"Bloqueado") vem de um refetch de GET /clients depois da
 * ação, que por sua vez cruza os MACs bloqueados vindos do controller fake —
 * ou seja, a mudança na tela só acontece se a ação chegou de verdade ao
 * controller.
 */
test('bloqueia e desbloqueia um cliente pela UI', async ({ page }) => {
  await login(page);
  await navigateTo(page, 'Clientes', 'Clientes');

  // A linha da tabela é o elemento pai da célula de MAC (um <span> dentro do
  // grid da linha) — ancorar pelo MAC evita depender de posição na lista.
  const macCell = page.getByText(SEEDED_CLIENT.mac, { exact: true });
  await expect(macCell).toBeVisible();
  const row = macCell.locator('..');

  await expect(row).toContainText(SEEDED_CLIENT.name);
  await expect(row).toContainText('Ativo');

  // --- Bloquear ---
  await row.getByRole('button', { name: 'Bloquear' }).click();

  await expect(row).toContainText('Bloqueado');
  await expect(row.getByRole('button', { name: 'Desbloquear' })).toBeVisible();

  // Prova que a ação atravessou backend -> controller (e não só mudou o
  // estado local do React).
  const afterBlock = await fakeControllerCalls();
  expect(afterBlock.filter((c) => c.path.endsWith('/cmd/stamgr')).length).toBe(1);

  // --- Desbloquear ---
  await row.getByRole('button', { name: 'Desbloquear' }).click();

  await expect(row).toContainText('Ativo');
  await expect(row.getByRole('button', { name: 'Bloquear' })).toBeVisible();

  const afterUnblock = await fakeControllerCalls();
  expect(afterUnblock.filter((c) => c.path.endsWith('/cmd/stamgr')).length).toBe(2);
});
