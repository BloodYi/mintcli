import type { Router } from 'express';
import { createSystemRouter } from './system.routes.js';
import { createSystemUpdateService } from './system.service.js';

type SystemModuleOptions = {
  appRoot: string;
  installMode: 'git' | 'npm';
  isPlatform: boolean;
};

/** Used by the server entrypoint; mintcli always rejects application update requests. */
export function createSystemModule(_options: SystemModuleOptions): Router {
  return createSystemRouter(createSystemUpdateService());
}
