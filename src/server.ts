import { buildApp } from './app.js';
import { env } from './config/env.js';

buildApp()
  .then((app) => app.listen({ port: env.PORT, host: '0.0.0.0' }))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
