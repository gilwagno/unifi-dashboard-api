import { expect, test } from '@playwright/test';
import { fakeControllerCalls, login, navigateTo } from './helpers';

const NEW_WIFI_NAME = 'E2E-Rede-Teste';
const NEW_WIFI_PASSWORD = 'senha-do-teste-e2e';

/**
 * Fluxo 3 — login -> criar uma rede Wi-Fi (WPA2-Personal, o formato mais
 * simples) -> confirmar na lista -> remover pela UI -> confirmar que sumiu.
 *
 * O formulário é preenchido e submetido de verdade; a remoção passa pelo
 * window.confirm nativo. A lista é sempre recarregada do backend depois de
 * cada ação, então o que o teste vê é o estado do controller fake, não um
 * otimismo do frontend.
 */
test('cria e remove uma rede Wi-Fi pela UI', async ({ page }) => {
  await login(page);
  await navigateTo(page, 'Redes', 'Redes');

  // A rede semeada no controller fake confirma que a lista carregou.
  await expect(page.getByText('Escritorio-Existente', { exact: true })).toBeVisible();
  await expect(page.getByText(NEW_WIFI_NAME, { exact: true })).toHaveCount(0);

  // --- Criar ---
  await page.getByPlaceholder('ex: Escritório').fill(NEW_WIFI_NAME);
  // O select já vem em "Senha (WPA2-Personal)", mas deixamos explícito para
  // o teste não depender do valor default do componente.
  await page.getByRole('combobox').first().selectOption('WPA2_PERSONAL');
  await page.getByPlaceholder('senha da rede').fill(NEW_WIFI_PASSWORD);
  await page.getByRole('button', { name: 'Criar rede Wi-Fi' }).click();

  const newWifiCell = page.getByText(NEW_WIFI_NAME, { exact: true });
  await expect(newWifiCell).toBeVisible();

  const row = newWifiCell.locator('..');
  await expect(row).toContainText('Ativa');

  const afterCreate = await fakeControllerCalls();
  expect(afterCreate.filter((c) => c.method === 'POST' && c.path.endsWith('/wifi/broadcasts')).length).toBe(1);

  // --- Remover (passa pelo window.confirm nativo) ---
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });

  await row.getByRole('button', { name: 'Remover' }).click();

  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0]).toContain(NEW_WIFI_NAME);

  await expect(page.getByText(NEW_WIFI_NAME, { exact: true })).toHaveCount(0);
  // A rede que já existia continua lá — só a criada pelo teste foi removida.
  await expect(page.getByText('Escritorio-Existente', { exact: true })).toBeVisible();

  const afterDelete = await fakeControllerCalls();
  expect(afterDelete.filter((c) => c.method === 'DELETE' && c.path.includes('/wifi/broadcasts/')).length).toBe(1);
});
