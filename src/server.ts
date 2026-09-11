import { buildApp } from './app.js';
import { env } from './config/env.js';
import { collectOnBoot } from './services/printer-snmp.service.js';

buildApp()
  .then((app) => app.listen({ port: env.PORT, host: '0.0.0.0' }))
  .then(() => {
    // Depois do listen, para não atrasar a subida do servidor. Ver
    // `collectOnBoot`: sem isso, todo restart deixa os consumíveis em
    // branco por até 15 minutos.
    collectOnBoot();
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
