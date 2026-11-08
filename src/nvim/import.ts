/** Import PhpStorm deployment configuration (.idea/deployment.xml, webServers.xml) into .vscode/iremote.json. */
import { importFromProject } from '../config/PhpStormImporter';
import { log } from '../util/log';
import { confirm } from './NvimCredentials';
import type { Context } from './context';
import type { Rpc } from './rpc';

export const registerImport = (rpc: Rpc, getCtx: () => Context): void => {
  rpc.on('importPhpStorm', async ({ root }: { root: string }) => {
    const ctx = getCtx();
    const project = await ctx.config.ensureProject(root);
    const result = await importFromProject(project.root);
    if (!result || result.servers.length === 0) return { imported: 0, warnings: [], root: project.root };
    let servers = result.servers;
    if (project.config.servers.length) {
      const choice = await confirm(
        rpc,
        `Import ${result.servers.length} PhpStorm server(s)?`,
        `${project.config.servers.length} server(s) are already configured.`,
        ['Merge (keep existing)', 'Replace', 'Cancel'],
      );
      if (!choice || choice === 'Cancel') return null;
      if (choice.startsWith('Merge')) {
        const existing = new Set(project.config.servers.map((x) => x.id));
        servers = [...project.config.servers, ...result.servers.filter((x) => !existing.has(x.id))];
      }
    }
    await ctx.config.saveProject(project, {
      ...project.config,
      servers,
      defaultServer: result.defaultServer ?? project.config.defaultServer,
      options: project.config.servers.length ? project.config.options : result.options,
    });
    result.warnings.forEach((w) => log.info(`Import: ${w}`));
    return { imported: result.servers.length, warnings: result.warnings, root: project.root };
  });
};
