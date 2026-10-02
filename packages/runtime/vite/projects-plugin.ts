import type { Plugin } from 'vite';
import { handleProjectRequest, handleSaveRequest, handleSelectionRequest, liveRunOfFile, projectOfFile } from './project-files';

/**
 * Serves project data to the runtime page and tells it when project files change,
 * so edits (by the user or by the agent) show up without a manual reload. Also announces
 * every update of the agent's published run (follow mode).
 */
export function vibeProjects(projectsRoot: string): Plugin {
  return {
    name: 'vibe-projects',
    configureServer(server) {
      const send = (res: import('node:http').ServerResponse, result: { status: number; type: string; body: string | Buffer }) => {
        res.statusCode = result.status;
        res.setHeader('Content-Type', result.type);
        res.setHeader('Cache-Control', 'no-store');
        res.end(result.body);
      };
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next();
        const handler = /\/save(\?|$)/.test(req.url) ? handleSaveRequest : /\/selection(\?|$)/.test(req.url) ? handleSelectionRequest : null;
        if (handler && req.url.startsWith('/api/projects/')) {
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', () => {
            const result = handler(projectsRoot, req.method ?? 'GET', req.url!, Buffer.concat(chunks).toString('utf8'));
            if (result) send(res, result);
            else next();
          });
          return;
        }
        const result = req.method === 'GET' ? handleProjectRequest(projectsRoot, req.url) : null;
        if (!result) return next();
        send(res, result);
      });

      server.watcher.add(projectsRoot);
      server.watcher.on('all', (event, file) => {
        if (event !== 'add' && event !== 'change' && event !== 'unlink') return;
        const hit = projectOfFile(projectsRoot, file);
        if (hit) server.ws.send({ type: 'custom', event: 'vibe:project-changed', data: hit });
        const live = event !== 'unlink' && liveRunOfFile(projectsRoot, file);
        if (live) server.ws.send({ type: 'custom', event: 'vibe:live-changed', data: { name: live } });
      });
    },
  };
}
