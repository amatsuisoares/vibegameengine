import { filterEntities, hierarchyKey, type EntityKind, type Hierarchy, type HierarchyEntity } from '@vibe/runtime';

export interface PanelSelection {
  scene: string;
  entity: string | null;
}

const KIND_ICONS: Record<EntityKind, string> = {
  player: '☺',
  text: 'T',
  enemy: '✖',
  pickup: '◆',
  zone: '▢',
  solid: '■',
  sprite: '●',
  logic: '⚙',
  empty: '·',
};

const KIND_LABELS: Record<EntityKind, string> = {
  player: 'jogador',
  text: 'texto',
  enemy: 'inimigo',
  pickup: 'coletável',
  zone: 'zona (trigger)',
  solid: 'sólido',
  sprite: 'visual',
  logic: 'lógica',
  empty: 'vazia',
};

/**
 * Hierarchy panel: scenes → entities of the project, live for the current scene. Selecting a
 * row only tells `onSelect` (the page outlines the entity and shares the selection with the
 * agent); the panel never changes the game.
 */
export class HierarchyPanel {
  private hierarchy: Hierarchy = { scenes: [] };
  private key = '';
  private query = '';
  private selection: PanelSelection | null = null;
  /** Scenes the user collapsed / expanded by hand (the current one starts open, others closed). */
  private readonly toggled = new Map<string, boolean>();
  private readonly list: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly onSelect: (sel: PanelSelection | null) => void,
  ) {
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Filtrar (id, tag, componente)';
    search.className = 'hierarchy-search';
    search.oninput = () => {
      this.query = search.value;
      this.render();
    };
    this.list = document.createElement('div');
    this.list.className = 'hierarchy-list';
    this.list.setAttribute('role', 'tree');
    root.append(search, this.list);
    root.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && this.selection) {
        this.select(null);
        ev.stopPropagation();
      }
    });
  }

  get selected(): PanelSelection | null {
    return this.selection;
  }

  /** New data from the game; redraws only when something listed changed. */
  update(h: Hierarchy) {
    this.hierarchy = h;
    const key = hierarchyKey(h);
    if (key === this.key) return;
    this.key = key;
    this.render();
  }

  /** Selects without notifying (e.g. restoring the saved selection). */
  setSelection(sel: PanelSelection | null) {
    this.selection = sel;
    this.render();
  }

  private select(sel: PanelSelection | null) {
    this.selection = sel;
    this.render();
    this.onSelect(sel);
  }

  private render() {
    const sel = this.selection;
    this.list.replaceChildren(
      ...this.hierarchy.scenes.map((scene) => {
        const details = document.createElement('details');
        details.className = 'hierarchy-scene';
        details.dataset.scene = scene.id;
        details.open = this.query ? true : (this.toggled.get(scene.id) ?? scene.current);
        details.ontoggle = () => {
          if (!this.query) this.toggled.set(scene.id, details.open);
        };
        const summary = document.createElement('summary');
        const title = document.createElement('span');
        title.className = 'scene-title';
        title.textContent = scene.name === scene.id ? scene.id : `${scene.name} (${scene.id})`;
        summary.append(title);
        const badges = [scene.current && 'atual', scene.start && 'início'].filter(Boolean) as string[];
        for (const b of badges) summary.append(badge(b));
        const entities = filterEntities(scene.entities, this.query);
        const count = document.createElement('span');
        count.className = 'count';
        count.textContent = this.query ? `${entities.length}/${scene.entities.length}` : String(scene.entities.length);
        summary.append(count);
        details.append(summary);
        for (const e of entities) details.append(this.row(scene.id, e, sel?.scene === scene.id && sel.entity === e.id));
        return details;
      }),
    );
  }

  private row(scene: string, e: HierarchyEntity, selected: boolean): HTMLElement {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'hierarchy-entity';
    row.dataset.entity = e.id;
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-selected', String(selected));
    row.classList.toggle('selected', selected);
    row.classList.toggle('disabled', !e.enabled);
    row.classList.toggle('destroyed', e.destroyed);
    row.classList.toggle('spawned', e.spawned);
    const icon = document.createElement('span');
    icon.className = `icon kind-${e.kind}`;
    icon.textContent = KIND_ICONS[e.kind];
    const id = document.createElement('span');
    id.className = 'id';
    id.textContent = e.id;
    row.append(icon, id);
    if (e.name !== e.id) {
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = e.name;
      row.append(name);
    }
    if (e.prefab) row.append(badge(`⧉ ${e.prefab}`));
    if (e.spawned) row.append(badge('criada'));
    if (e.destroyed) row.append(badge('destruída'));
    else if (!e.enabled) row.append(badge('desativada'));
    row.title = [
      `${e.id} — ${KIND_LABELS[e.kind]}`,
      e.tags.length ? `tags: ${e.tags.join(', ')}` : '',
      e.components.length ? `componentes: ${e.components.join(', ')}` : 'sem componentes',
      e.prefab ? `prefab: ${e.prefab}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    row.onclick = () => this.select(selected ? null : { scene, entity: e.id });
    return row;
  }
}

function badge(text: string) {
  const b = document.createElement('span');
  b.className = 'badge';
  b.textContent = text;
  return b;
}
