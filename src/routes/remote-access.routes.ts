import type { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';
import { remoteAccessSyncService } from '../services/remote-access-sync.service.js';
import { remoteAccessService } from '../services/remote-access.service.js';

// Rotas de Acesso Remoto (Onda 4). Esta subtarefa (4) entrega só a
// SINCRONIZAÇÃO AD -> Guacamole; listar computadores com status de acesso e
// abrir sessão são a subtarefa 5.
//
// Mesmo padrão do resto do projeto: auth central, rate limit restrito em
// mutação, erros tipados do serviço mapeados pelo error handler central de
// src/app.ts (nenhum try/catch aqui).
export default async function remoteAccessRoutes(app: FastifyInstance): Promise<void> {
  // Guarda de autenticação do contexto — mesmo padrão de ad.routes.ts e
  // printers.routes.ts. Estava FALTANDO na primeira versão deste arquivo, e
  // as duas rotas respondiam 200 sem token nenhum; quem pegou foram os dois
  // testes "exige autenticação" desta subtarefa. Registro porque a lição é
  // do tamanho do achado: num projeto onde a autenticação é aplicada POR
  // ARQUIVO de rotas, um arquivo novo nasce aberto por padrão, e nada no
  // compilador ou no lint reclama. Todo arquivo de rotas novo precisa deste
  // hook e de um teste que o prove.
  app.addHook('preHandler', app.authenticate);

  const mutationConfig = {
    config: { rateLimit: { max: env.RATE_LIMIT_CLIENT_ACTION_MAX, timeWindow: env.RATE_LIMIT_WINDOW } },
  };

  // Catálogo atual do Guacamole, com a âncora de cada conexão. Leitura pura —
  // útil para conferir o resultado de um sync sem abrir a UI do Guacamole.
  app.get('/remote-access/connections', async () => {
    const data = await remoteAccessService.listConnectionsWithAnchors();
    return { data };
  });

  // Reconcilia o catálogo do Guacamole com a lista de computadores do AD.
  //
  // É IDEMPOTENTE: rodar duas vezes seguidas não duplica nada e, sem
  // mudança no AD, a segunda execução não escreve no Guacamole. A correlação
  // é pelo `objectGUID` gravado no parâmetro `ad-object-guid` da conexão.
  //
  // Conexões sem essa âncora foram criadas à mão no Guacamole e NUNCA são
  // tocadas — voltam no relatório em `ignoradas`.
  app.post('/remote-access/sync', mutationConfig, async () => {
    const resultado = await remoteAccessSyncService.syncComputersToGuacamole();
    return {
      resumo: {
        criadas: resultado.criadas.length,
        atualizadas: resultado.atualizadas.length,
        inalteradas: resultado.inalteradas.length,
        removidas: resultado.removidas.length,
        puladas: resultado.puladas.length,
        ignoradas: resultado.ignoradas.length,
      },
      ...resultado,
    };
  });
}
