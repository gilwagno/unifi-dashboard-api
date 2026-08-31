import { env } from '../config/env.js';
import { createPrintersRepository } from './printers.db.js';

// Instância singleton do repositório de impressoras (SQLite em
// `env.PRINTERS_DB_FILE`). Vivia dentro de src/routes/printers.routes.ts
// (subtarefa 1) e foi extraída aqui na subtarefa 5: o poller SNMP também
// precisa ler o cadastro, e um serviço importando um módulo de rota criaria
// um ciclo assim que a rota da subtarefa 6 importar o poller. As rotas
// reexportam `printersRepository` daqui, então os testes que já importam
// esse símbolo de `src/routes/printers.routes.js` continuam funcionando —
// e continuam recebendo exatamente a MESMA instância que o poller usa
// (importante: são duas conexões SQLite distintas se instanciado duas
// vezes, e o `:memory:` dos testes nem seria o mesmo banco).
export const printersRepository = createPrintersRepository(env.PRINTERS_DB_FILE);
