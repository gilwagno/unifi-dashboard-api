import { expect, test } from '@playwright/test';
import { login, navigateTo } from './helpers';

/**
 * Fluxo 2 — login -> rotacionar a credencial de SSH -> confirmar que o
 * segredo some da tela ao navegar.
 *
 * A senha nova é devolvida em texto puro UMA ÚNICA VEZ pelo backend e fica
 * apenas no estado do componente React (nunca em localStorage). Este teste
 * verifica as duas metades da promessa: (a) ela realmente aparece, e (b) ela
 * realmente desaparece — do DOM e do armazenamento do browser — assim que se
 * sai da página.
 */
test('rotaciona a senha de SSH e o segredo some ao navegar', async ({ page }) => {
  await login(page);
  await navigateTo(page, 'Segurança', 'Segurança');

  const sshCard = page.getByText('Credencial SSH dos equipamentos').locator('..').locator('..');
  await expect(sshCard).toContainText('Usuário atual:');
  await expect(sshCard).toContainText('ubnt');

  // O botão dispara um window.confirm nativo antes de chamar a API.
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });

  await sshCard.getByRole('button', { name: 'Gerar nova senha' }).click();

  // O confirm precisa ter acontecido de verdade — se o botão perdesse o
  // handler, nenhum dialog apareceria.
  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0]).toContain('trocar a senha de SSH');

  // --- A senha nova aparece na tela ---
  const secretBox = page.getByText('Copie agora', { exact: false }).first().locator('..');
  await expect(secretBox).toBeVisible();

  const boxText = await secretBox.innerText();
  const match = boxText.match(/senha:\s*(\S+)/);
  expect(match, `bloco da senha não tinha o formato esperado: ${boxText}`).not.toBeNull();
  const password = match![1];

  // randomBytes(24).toString('base64url') -> 32 caracteres base64url.
  expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/);
  await expect(page.locator('body')).toContainText(password);

  // --- Sai da página: o segredo tem que sumir ---
  await navigateTo(page, 'Clientes', 'Clientes');
  await expect(page.locator('body')).not.toContainText(password);

  // --- Volta para Segurança: continua sem aparecer em lugar nenhum ---
  await navigateTo(page, 'Segurança', 'Segurança');
  await expect(page.getByText('Usuário atual:')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(password);
  await expect(page.getByText('Copie agora', { exact: false })).toHaveCount(0);

  // E também não pode ter sido persistido no browser.
  const storageDump = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(storageDump).not.toContain(password);
});
