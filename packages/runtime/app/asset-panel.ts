import type { AssetCatalog, AssetEntry, AssetUse, PrefabEntry, ScriptEntry, UndeclaredFile } from '@vibe/server';

export interface AssetPanelHost {
  /** Project folder name (for the /api routes and asset URLs). */
  project: string;
  pixelArt(): boolean;
  /** Source of a script, as loaded by the game. */
  scriptSource(path: string): string | undefined;
  /** The selected entity, if any (for "use on the selection"). */
  selectedEntity(): { scene: string; entity: string } | null;
  /** Sets Sprite.asset of the selected entity (a user edit). Resolves to an error message, or null. */
  useOnSelection(asset: string): Promise<string | null>;
  /** Places an instance of the prefab in the scene being shown. Resolves to an error message, or null. */
  place(prefab: string): Promise<string | null>;
  /** Selects an entity (an instance of a prefab) in the hierarchy. */
  selectEntity(scene: string, id: string): void;
}

type Tab = 'images' | 'audio' | 'prefabs' | 'scripts' | 'undeclared';
type Item =
  | { kind: 'asset'; key: string; asset: AssetEntry }
  | { kind: 'prefab'; key: string; prefab: PrefabEntry }
  | { kind: 'script'; key: string; script: ScriptEntry }
  | { kind: 'undeclared'; key: string; file: UndeclaredFile };

const TABS: [Tab, string][] = [
  ['images', 'Imagens'],
  ['audio', 'Áudio'],
  ['prefabs', 'Prefabs'],
  ['scripts', 'Scripts'],
  ['undeclared', 'Não declarados'],
];

/** An element with properties (className, textContent, src...) and children. */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

const kb = (bytes: number | null) => (bytes === null ? 'arquivo ausente' : bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 102.4) / 10} KB`);

/**
 * Asset browser: what the project has to build with — images and spritesheets (thumbnails, size,
 * frames), audio (length, events, a player), prefabs (preview, instances, place in the scene) and
 * scripts (source) — with where each is used and what is wrong (missing files, frames that do not
 * fit, files nobody declared). Data comes from the server's asset catalog (the agent's list_assets).
 */
export class AssetPanel {
  private catalog: AssetCatalog | null = null;
  private tab: Tab = 'images';
  private selectedKey: string | null = null;
  private filter = '';
  private seq = 0;
  private readonly tabsEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly detailEl: HTMLElement;
  private readonly searchEl: HTMLInputElement;

  constructor(
    root: HTMLElement,
    private readonly host: AssetPanelHost,
  ) {
    this.tabsEl = el('nav', { className: 'assets-tabs' });
    this.searchEl = el('input', { type: 'search', placeholder: 'Filtrar…', className: 'assets-search' });
    this.searchEl.oninput = () => {
      this.filter = this.searchEl.value.trim().toLowerCase();
      this.renderList();
    };
    this.listEl = el('div', { className: 'assets-list' });
    this.detailEl = el('div', { className: 'assets-detail' });
    root.append(el('div', { className: 'assets-head' }, this.tabsEl, this.searchEl), el('div', { className: 'assets-body' }, this.listEl, this.detailEl));
  }

  /** Re-reads the catalog (on open, and when project files change). */
  async refresh() {
    const seq = ++this.seq;
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(this.host.project)}/assets`);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      if (seq !== this.seq) return;
      this.catalog = body as AssetCatalog;
    } catch (err) {
      this.detailEl.replaceChildren(el('div', { className: 'inspector-message', textContent: `Não foi possível ler os assets: ${err instanceof Error ? err.message : String(err)}` }));
      return;
    }
    this.render();
  }

  /** The selection changed: the "use on the selection" button names it. */
  selectionChanged() {
    if (this.catalog) this.renderList();
  }

  private assetUrl(path: string) {
    // path is "assets/..." inside the project.
    return `/projects/${encodeURIComponent(this.host.project)}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  private items(tab: Tab): Item[] {
    const c = this.catalog;
    if (!c) return [];
    switch (tab) {
      case 'images':
        return c.assets.filter((a) => a.type !== 'audio').map((a) => ({ kind: 'asset', key: `asset:${a.id}`, asset: a }));
      case 'audio':
        return c.assets.filter((a) => a.type === 'audio').map((a) => ({ kind: 'asset', key: `asset:${a.id}`, asset: a }));
      case 'prefabs':
        return c.prefabs.map((p) => ({ kind: 'prefab', key: `prefab:${p.id}`, prefab: p }));
      case 'scripts':
        return c.scripts.map((s) => ({ kind: 'script', key: `script:${s.path}`, script: s }));
      case 'undeclared':
        return c.undeclared.map((f) => ({ kind: 'undeclared', key: `file:${f.path}`, file: f }));
    }
  }

  private render() {
    this.tabsEl.replaceChildren(
      ...TABS.filter(([t]) => t !== 'undeclared' || this.items(t).length).map(([t, label]) => {
        const items = this.items(t);
        const warn = items.some((i) => i.kind === 'asset' && i.asset.warnings.length) || t === 'undeclared';
        const b = el('button', { className: `assets-tab${t === this.tab ? ' active' : ''}${warn ? ' warn' : ''}` }, `${label} `, el('span', { className: 'badge', textContent: String(items.length) }));
        b.dataset.tab = t;
        b.onclick = () => {
          this.tab = t;
          this.render();
        };
        return b;
      }),
    );
    this.renderList();
  }

  private renderList() {
    const items = this.items(this.tab).filter((i) => !this.filter || i.key.toLowerCase().includes(this.filter));
    this.listEl.classList.toggle('pixelated', this.host.pixelArt());
    this.detailEl.classList.toggle('pixelated', this.host.pixelArt());
    this.listEl.replaceChildren(...(items.length ? items.map((i) => this.card(i)) : [el('div', { className: 'muted', textContent: 'Nada aqui.' })]));
    const current = this.items(this.tab).find((i) => i.key === this.selectedKey);
    this.renderDetail(current ?? null);
  }

  private unused(i: Item) {
    if (i.kind === 'asset') return !i.asset.uses.length && !i.asset.events?.length;
    if (i.kind === 'prefab') return !i.prefab.uses.length && !i.prefab.instances.length;
    if (i.kind === 'script') return !i.script.uses.length;
    return true;
  }

  private card(i: Item) {
    const card = el('button', { className: `asset-card${i.key === this.selectedKey ? ' selected' : ''}` });
    card.dataset.key = i.key;
    card.onclick = () => {
      this.selectedKey = this.selectedKey === i.key ? null : i.key;
      this.renderList();
    };
    const label = (text: string, sub: string) => [el('span', { className: 'asset-name', textContent: text, title: text }), el('span', { className: 'muted', textContent: sub })];
    if (i.kind === 'asset') {
      const a = i.asset;
      const sub =
        a.type === 'audio'
          ? `${a.seconds !== undefined ? `${a.seconds}s` : kb(a.bytes)}${a.events?.length ? ` · ${a.events.join(', ')}` : ''}`
          : a.frames
            ? `${a.frames.columns}×${a.frames.rows} quadros`
            : a.width
              ? `${a.width}×${a.height}`
              : kb(a.bytes);
      card.append(this.thumb(a), ...label(a.id, sub));
      if (a.warnings.length) card.classList.add('warn');
    } else if (i.kind === 'prefab') {
      const p = i.prefab;
      card.append(this.prefabThumb(p), ...label(p.id, `${p.instances.length} na cena · ${p.components.length} comp.`));
      if (p.error) card.classList.add('warn');
    } else if (i.kind === 'script') {
      card.append(el('span', { className: 'asset-thumb icon', textContent: '{ }' }), ...label(i.script.path.replace(/^scripts\//, ''), `${i.script.lines} linhas`));
    } else {
      const f = i.file;
      card.append(
        f.kind === 'image' ? el('img', { className: 'asset-thumb', src: this.assetUrl(f.path), alt: '' }) : el('span', { className: 'asset-thumb icon', textContent: f.kind === 'audio' ? '♪' : '?' }),
        ...label(f.path.replace(/^assets\//, ''), kb(f.bytes)),
      );
      card.classList.add('warn');
    }
    if (this.unused(i) && i.kind !== 'undeclared') card.append(el('span', { className: 'asset-unused', textContent: 'não usado' }));
    return card;
  }

  private thumb(a: AssetEntry) {
    if (a.type === 'audio') return el('span', { className: 'asset-thumb icon', textContent: '♪' });
    if (a.bytes === null) return el('span', { className: 'asset-thumb icon', textContent: '⚠' });
    return el('img', { className: 'asset-thumb', src: this.assetUrl(a.path), alt: '', loading: 'lazy' });
  }

  private prefabThumb(p: PrefabEntry) {
    const s = p.sprite;
    const asset = s?.asset ? this.catalog?.assets.find((a) => a.id === s.asset) : undefined;
    if (asset?.frames) {
      // A spritesheet: just its first frame.
      const f = asset.frames;
      const frame = el('span', { className: 'asset-frame-thumb' });
      Object.assign(frame.style, {
        width: `${Math.min(48, (48 * f.frameWidth) / Math.max(f.frameWidth, f.frameHeight))}px`,
        height: `${Math.min(48, (48 * f.frameHeight) / Math.max(f.frameWidth, f.frameHeight))}px`,
        backgroundImage: `url("${this.assetUrl(asset.path)}")`,
        backgroundSize: `${(asset.width! / f.frameWidth) * 100}% ${(asset.height! / f.frameHeight) * 100}%`,
      });
      return el('span', { className: 'asset-thumb icon' }, frame);
    }
    if (asset && asset.type !== 'audio' && asset.bytes !== null) return el('img', { className: 'asset-thumb', src: this.assetUrl(asset.path), alt: '' });
    const box = el('span', { className: 'asset-thumb icon' });
    if (s) {
      const shape = el('span', { className: `prefab-shape ${s.shape ?? 'rect'}` });
      const w = s.width ?? 32;
      const h = s.height ?? 32;
      const k = 36 / Math.max(w, h, 1);
      shape.style.width = `${Math.max(4, w * k)}px`;
      shape.style.height = `${Math.max(4, h * k)}px`;
      shape.style.background = s.color ?? '#ffffff';
      box.append(shape);
    } else box.textContent = p.components.includes('Text') ? 'T' : '◇';
    return box;
  }

  private renderDetail(i: Item | null) {
    const d = this.detailEl;
    if (!i) {
      d.replaceChildren(el('p', { className: 'muted', textContent: 'Selecione um item para ver detalhes, onde é usado e ações.' }));
      return;
    }
    const parts: Node[] = [];
    const message = el('div', { className: 'inspector-message', hidden: true });
    const run = async (button: HTMLButtonElement, action: () => Promise<string | null>) => {
      button.disabled = true;
      const error = await action();
      button.disabled = false;
      message.hidden = !error;
      message.textContent = error ?? '';
    };
    if (i.kind === 'asset') {
      const a = i.asset;
      parts.push(el('strong', { textContent: a.id }), el('div', { className: 'muted', textContent: `${a.type} · ${a.path} · ${kb(a.bytes)}` }));
      if (a.width) parts.push(el('div', { textContent: `${a.width}×${a.height} px` }));
      if (a.frames) parts.push(el('div', { textContent: `quadros ${a.frames.frameWidth}×${a.frames.frameHeight}: ${a.frames.columns} colunas × ${a.frames.rows} linhas = ${a.frames.count}` }));
      if (a.seconds !== undefined) parts.push(el('div', { textContent: `${a.seconds} s` }));
      if (a.events?.length) parts.push(el('div', { textContent: `toca nos eventos: ${a.events.join(', ')}` }));
      parts.push(...a.warnings.map((w) => el('div', { className: 'asset-warning', textContent: `⚠ ${w}` })));
      if (a.type === 'audio' && a.bytes !== null) parts.push(el('audio', { controls: true, src: this.assetUrl(a.path), preload: 'none' }));
      else if (a.bytes !== null) parts.push(this.preview(a));
      if (a.type !== 'audio') {
        const sel = this.host.selectedEntity();
        const use = el('button', {
          textContent: sel ? `Usar em ${sel.entity} (Sprite.asset)` : 'Usar na seleção (Sprite.asset)',
          disabled: !sel,
          title: sel ? '' : 'Selecione uma entidade na hierarquia ou no viewport',
        });
        use.dataset.action = 'use';
        use.onclick = () => run(use, () => this.host.useOnSelection(a.id));
        parts.push(el('div', { className: 'assets-actions' }, use));
      }
      parts.push(this.uses(a.uses, 'Não é usado em cenas, prefabs nem scripts.'));
    } else if (i.kind === 'prefab') {
      const p = i.prefab;
      parts.push(el('strong', { textContent: p.id }), el('div', { className: 'muted', textContent: p.file }));
      if (p.error) parts.push(el('div', { className: 'asset-warning', textContent: `⚠ ${p.error}` }));
      if (p.tags.length) parts.push(el('div', { textContent: `tags: ${p.tags.join(', ')}` }));
      parts.push(el('div', { textContent: `componentes: ${p.components.join(', ') || '—'}` }));
      const place = el('button', { textContent: 'Colocar na cena', title: 'Cria uma instância no centro da vista (edição sua, com histórico e undo)' });
      place.dataset.action = 'place';
      place.onclick = () => run(place, () => this.host.place(p.id));
      parts.push(el('div', { className: 'assets-actions' }, place));
      parts.push(el('h4', { textContent: `Instâncias (${p.instances.length})` }));
      if (p.instances.length) {
        parts.push(
          el(
            'ul',
            { className: 'asset-uses' },
            ...p.instances.map((inst) => {
              const a = el('a', { href: '#', textContent: `${inst.scene} › ${inst.id}` });
              a.onclick = (e) => {
                e.preventDefault();
                this.host.selectEntity(inst.scene, inst.id);
              };
              return el('li', {}, a);
            }),
          ),
        );
      }
      parts.push(this.uses(p.uses, p.instances.length ? 'Nenhum spawn em regras ou scripts.' : 'Não é usado: sem instâncias nem spawn.'));
    } else if (i.kind === 'script') {
      const s = i.script;
      parts.push(el('strong', { textContent: s.path }), el('div', { className: 'muted', textContent: `${s.lines} linhas · ${kb(s.bytes)} · edite pelo Claude Code ou no editor` }));
      parts.push(this.uses(s.uses, 'Nenhuma entidade ou prefab usa este script.'));
      parts.push(el('pre', { className: 'asset-source', textContent: this.host.scriptSource(s.path) ?? '(fonte indisponível)' }));
    } else {
      const f = i.file;
      parts.push(
        el('strong', { textContent: f.path }),
        el('div', { className: 'muted', textContent: `${kb(f.bytes)} · não declarado em project.json` }),
        el('p', { textContent: 'Arquivos fora de config.assets não podem ser usados por id. Peça ao agente para declarar (ou apagar) o arquivo.' }),
      );
      if (f.kind === 'image') parts.push(el('img', { className: 'asset-preview', src: this.assetUrl(f.path), alt: '' }));
      if (f.kind === 'audio') parts.push(el('audio', { controls: true, src: this.assetUrl(f.path), preload: 'none' }));
    }
    d.replaceChildren(message, ...parts);
  }

  /** The image, with the frame grid and indices of a spritesheet. */
  private preview(a: AssetEntry) {
    const img = el('img', { className: 'asset-preview', src: this.assetUrl(a.path), alt: '' });
    const f = a.frames;
    if (!f || !a.width || !a.height) return img;
    const wrap = el('div', { className: 'asset-sheet' }, img);
    for (let r = 0; r < f.rows; r++) {
      for (let c = 0; c < f.columns; c++) {
        const cell = el('span', { className: 'asset-frame', textContent: String(r * f.columns + c) });
        Object.assign(cell.style, {
          left: `${((c * f.frameWidth) / a.width) * 100}%`,
          top: `${((r * f.frameHeight) / a.height) * 100}%`,
          width: `${(f.frameWidth / a.width) * 100}%`,
          height: `${(f.frameHeight / a.height) * 100}%`,
        });
        wrap.append(cell);
      }
    }
    return wrap;
  }

  private uses(uses: AssetUse[], empty: string) {
    if (!uses.length) return el('p', { className: 'muted', textContent: empty });
    return el(
      'div',
      {},
      el('h4', { textContent: `Usado em (${uses.length})` }),
      el('ul', { className: 'asset-uses' }, ...uses.map((u) => el('li', {}, el('span', { textContent: u.file }), ' ', el('span', { className: 'muted', textContent: u.at })))),
    );
  }
}
