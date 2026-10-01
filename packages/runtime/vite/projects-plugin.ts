import type { Plugin } from 'vite';
import { handleProjectRequest, liveRunOfFile, projectOfFile } from './project-files';

/**
 * Serves project data to the runtime page and tells it when project files change,
 * so edits (by the user or by the agent) show up without a manual reload. Also announces
 * every update of the agent's published run (follow mode).
 */
export function vibeProjects(projectsRoot: string): Plugin {
  return {
    name: 'vibe-projects',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const result = req.method === 'GET' && req.url ? handleProjectRequest(projectsRoot, req.url) : null;
        if (!result) return next();
        res.statusCode = result.status;
        res.setHeader('Content-Type', result.type);
        res.setHeader('Cache-Control', 'no-store');
        res.end(result.body);
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
