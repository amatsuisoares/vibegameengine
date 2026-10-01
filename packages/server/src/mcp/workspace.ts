import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IdSchema } from '@vibe/shared';
import { writeFileAtomic } from '../fs-atomic';
import { formatJson } from '../json-format';
import { ProjectStore, ToolError } from '../project-store';
import { RuntimeHost } from '../runtime/host';
import { Screenshotter } from '../runtime/screenshotter';

export interface OpenProject {
  store: ProjectStore;
  host: RuntimeHost;
}

/**
 * The projects folder the MCP server works in, and the project currently open.
 * One Chromium/Vite screenshotter is shared by every project opened in the session.
 */
export class Workspace {
  private current: OpenProject | null = null;
  private readonly screenshotter = new Screenshotter();

  constructor(readonly projectsRoot: string) {}

  list(): { name: string; title: string; open: boolean }[] {
    if (!existsSync(this.projectsRoot)) return [];
    return readdirSync(this.projectsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && IdSchema.safeParse(d.name).success && existsSync(join(this.projectsRoot, d.name, 'project.json')))
      .map((d) => {
        let title = d.name;
        try {
          title = JSON.parse(readFileSync(join(this.projectsRoot, d.name, 'project.json'), 'utf8')).name ?? d.name;
        } catch {
          // Listed anyway: the error shows up when the project is opened.
        }
        return { name: d.name, title, open: this.current?.store.name === d.name };
      });
  }

  open(name: string): OpenProject {
    if (!IdSchema.safeParse(name).success || !existsSync(join(this.projectsRoot, name, 'project.json'))) {
      const names = this.list().map((p) => p.name);
      throw new ToolError(`Project "${name}" not found. Projects: ${names.join(', ') || '(none)'}`);
    }
    if (this.current?.store.name === name) return this.current;
    this.current?.host.stop();
    const store = new ProjectStore(join(this.projectsRoot, name));
    this.current = { store, host: new RuntimeHost(store, this.screenshotter) };
    return this.current;
  }

  /** The open project; when none is open and exactly one exists, that one is opened. */
  require(): OpenProject {
    if (this.current) return this.current;
    const all = this.list();
    if (all.length === 1) return this.open(all[0].name);
    throw new ToolError(`No project is open. Call open_project (projects: ${all.map((p) => p.name).join(', ') || 'none'}) or create_project.`);
  }

  get openName(): string | null {
    return this.current?.store.name ?? null;
  }

  /** Creates projects/<name> with an empty start scene and opens it. */
  create(name: string, options: { title?: string; width?: number; height?: number; sceneWidth?: number; sceneHeight?: number }): OpenProject {
    if (!IdSchema.safeParse(name).success) throw new ToolError(`Invalid project name "${name}": use letters, digits, "_" or "-", starting with a letter`);
    const dir = join(this.projectsRoot, name);
    if (existsSync(dir)) throw new ToolError(`Project "${name}" already exists`);
    const width = options.width ?? 800;
    const height = options.height ?? 450;
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileAtomic(join(dir, 'project.json'), formatJson({ formatVersion: 1, name: options.title ?? name, width, height, startScene: 'main', assets: [] }));
    writeFileAtomic(
      join(dir, 'scenes', 'main.json'),
      formatJson({ id: 'main', width: options.sceneWidth ?? width, height: options.sceneHeight ?? height, vars: {}, entities: [] }),
    );
    return this.open(name);
  }

  async close() {
    this.current?.host.stop();
    this.current = null;
    await this.screenshotter.close();
  }
}
