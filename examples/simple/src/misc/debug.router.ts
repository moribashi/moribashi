import type { FastifyInstance } from '@moribashi/web';
import { diagnostics as commonDiagnostics } from '@moribashi/common';
import { diagnostics as coreDiagnostics } from '@moribashi/core';
import { diagnostics as cliDiagnostics } from '@moribashi/cli';
import { diagnostics as webDiagnostics } from '@moribashi/web';

export default function debugRoutes(fastify: FastifyInstance) {
  fastify.get('/debug', async () => {
    return {
      common: commonDiagnostics(),
      core: coreDiagnostics(),
      cli: cliDiagnostics(),
      web: webDiagnostics(),
    };
  });
}
