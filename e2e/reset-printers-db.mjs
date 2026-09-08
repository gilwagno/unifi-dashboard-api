/**
 * Zera o banco SQLite de impressoras usado pela suíte e2e, antes do backend
 * subir (ver `webServer` do backend em playwright.config.ts).
 *
 * Por que isso é necessário: diferente de todo o resto do estado e2e (o
 * controller fake é 100% memória e renasce limpo a cada boot), o cadastro de
 * impressoras é PERSISTIDO EM DISCO. O fluxo A cadastra a impressora e o
 * fluxo B a remove, então uma run completa e verde se auto-limpa — mas
 * qualquer run interrompida no meio (falha de um teste, Ctrl+C, ou
 * simplesmente rodar um subconjunto com `--grep`) deixa o registro no
 * arquivo, e a partir daí TODA run seguinte falha no primeiro `expect` do
 * fluxo A ("Nenhuma impressora cadastrada.") até alguém apagar o arquivo na
 * mão — com uma mensagem de erro que não aponta pra causa.
 *
 * Apagar aqui (e não em globalSetup) garante a ordem: o arquivo some antes
 * do processo do backend abrir a conexão SQLite.
 */
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// O arquivo principal e os sidecars que o SQLite pode deixar (journal/WAL).
// Precisa bater com PRINTERS_DB_FILE do playwright.config.ts.
const dbFile = join(here, '.printers-e2e.db');

for (const file of [dbFile, `${dbFile}-journal`, `${dbFile}-wal`, `${dbFile}-shm`]) {
  rmSync(file, { force: true });
}
