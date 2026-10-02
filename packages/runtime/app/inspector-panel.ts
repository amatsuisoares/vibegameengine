import type { Inspection, InspectorEdit, InspectorEditResult, InspectorField, InspectorSection } from '@vibe/server';
import type { PanelSelection } from './hierarchy-panel';

export interface InspectorHost {
  /** Project folder name (for the /api routes). */
  project: string;
  /** Live snapshot of the entity when it is in the running scene, else null. */
  live(scene: string, id: string): Record<string, unknown> | null;
  log(level: 'log' | 'warn' | 'error', message: string): void;
}

/** Live values worth showing (the rest is in the fields). */
const LIVE_KEYS = ['x', 'y', 'vx', 'vy', 'grounded', 'health', 'maxHealth', 'state', 'stateMs', 'props', 'interactable', 'ai', 'nav'];

/**
 * Inspector panel: the selected entity's components and properties as typed fields. Edits are
 * sent to the dev server, which applies them with the editing tools as the user (validated,
 * written atomically, in the history, undoable); a rejected edit writes nothing and shows why.
 * The game then hot-reloads like after any other edit.
 */
export class InspectorPanel {
  private selection: PanelSelection | null = null;
  private inspection: Inspection | null = null;
  private key = '';
  private seq = 0;
  private readonly body: HTMLElement;
  private readonly liveEl: HTMLElement;
  private readonly message: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly host: InspectorHost,
  ) {
    this.message = document.createElement('div');
    this.message.className = 'inspector-message';
    this.message.hidden = true;
    this.body = document.createElement('div');
    this.body.className = 'inspector-body';
    this.liveEl = document.createElement('section');
    this.liveEl.className = 'inspector-live';
    root.append(this.message, this.body, this.liveEl);
    this.renderEmpty();
  }

  get current() {
    return this.inspection;
  }

  /** Shows an entity (null = nothing selected). */
  async show(sel: PanelSelection | null) {
    this.selection = sel;
    this.inspection = null;
    this.key = '';
    this.showMessage(null);
    if (!sel?.entity) return this.renderEmpty();
    await this.load();
  }

  /** Re-reads the entity (its files changed: an edit here, by the agent or by hand). */
  async refresh() {
    if (this.selection?.entity) await this.load();
  }

  /** Updates the live values (called a few times per second). */
  updateLive() {
    const sel = this.selection;
    const snap = sel?.entity ? this.host.live(sel.scene, sel.entity) : null;
    this.liveEl.hidden = !snap;
    if (!snap) return;
    const rows = LIVE_KEYS.filter((k) => snap[k] !== undefined).map((k) => {
      const v = snap[k];
      return `<dt>${k}</dt><dd>${escapeHtml(typeof v === 'object' ? JSON.stringify(v) : String(v))}</dd>`;
    });
    const html = `<h3>Ao vivo</h3><dl>${rows.join('')}</dl>`;
    if (this.liveEl.innerHTML !== html) this.liveEl.innerHTML = html;
  }

  private async load() {
    const sel = this.selection!;
    const seq = ++this.seq;
    const url = `/api/projects/${encodeURIComponent(this.host.project)}/inspect?scene=${encodeURIComponent(sel.scene)}&id=${encodeURIComponent(sel.entity!)}`;
    let res: Response;
    let body: unknown;
    try {
      res = await fetch(url);
      body = await res.json();
    } catch (err) {
      if (seq === this.seq) this.showMessage(`Não foi possível ler a entidade: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (seq !== this.seq) return;
    if (!res.ok) {
      this.inspection = null;
      this.key = '';
      this.body.replaceChildren(
        note(
          /does not exist/.test(String((body as { error?: string }).error))
            ? `"${sel.entity}" não está no arquivo da cena "${sel.scene}" (foi criada durante o jogo ou apagada). Só os valores ao vivo aparecem.`
            : String((body as { error?: string }).error),
        ),
      );
      this.updateLive();
      return;
    }
    this.render(body as Inspection);
  }

  private async send(edit: InspectorEdit) {
    const sel = this.selection;
    if (!sel?.entity) return;
    let result: InspectorEditResult;
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(this.host.project)}/inspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scene: sel.scene, id: sel.entity, edit }),
      });
      result = await res.json();
    } catch (err) {
      this.showMessage(`Não foi possível salvar: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (this.selection !== sel) return;
    if (!result.ok) {
      this.showMessage([result.error, ...(result.details ?? [])].join('\n'));
      this.host.log('warn', `Inspector: ${result.error}`);
      // Put the field back to the stored value.
      this.key = '';
      if (result.inspection) this.render(result.inspection);
      return;
    }
    this.showMessage(null);
    this.render(result.inspection);
  }

  private showMessage(text: string | null) {
    this.message.hidden = !text;
    this.message.textContent = text ?? '';
  }

  private renderEmpty() {
    this.body.replaceChildren(note('Selecione uma entidade na hierarquia.'));
    this.liveEl.hidden = true;
  }

  private render(i: Inspection) {
    const key = JSON.stringify(i);
    this.inspection = i;
    if (key === this.key) return;
    this.key = key;
    const head = document.createElement('header');
    head.className = 'inspector-head';
    const title = document.createElement('strong');
    title.textContent = i.id;
    head.append(title);
    const where = document.createElement('span');
    where.className = 'muted';
    where.textContent = `cena ${i.scene}${i.prefab ? ` · prefab ${i.prefab}` : ''}`;
    head.append(where);
    const parts: HTMLElement[] = [head];
    if (i.invalid) parts.push(note('Os dados desta entidade são inválidos: corrija os campos marcados pelo erro ao salvar.'));
    for (const s of i.sections) parts.push(this.section(s));
    if (i.addable.length) parts.push(this.addComponent(i.addable));
    this.body.replaceChildren(...parts);
    this.updateLive();
  }

  private section(s: InspectorSection): HTMLElement {
    const details = document.createElement('details');
    details.className = 'inspector-section';
    details.dataset.section = s.id;
    details.open = true;
    const summary = document.createElement('summary');
    summary.textContent = s.title;
    if (s.description) summary.title = s.description;
    if (s.fromPrefab) summary.append(badge('⧉ prefab'));
    if (s.id !== 'entity' && s.id !== 'transform') {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove';
      remove.textContent = '✕';
      remove.title = s.fromPrefab ? 'Vem do prefab: edite o prefab para remover' : `Remover ${s.id}`;
      remove.disabled = !!s.fromPrefab;
      remove.onclick = (ev) => {
        ev.preventDefault();
        if (confirm(`Remover ${s.id} de ${this.selection?.entity}?`)) void this.send({ action: 'removeComponent', type: s.id as never });
      };
      summary.append(remove);
    }
    details.append(summary);
    for (const f of s.fields) details.append(this.field(s.id, f));
    return details;
  }

  private field(section: string, f: InspectorField): HTMLElement {
    const row = document.createElement('div');
    row.className = 'inspector-field';
    row.dataset.key = f.key;
    row.classList.toggle('set', f.set);
    row.classList.toggle('prefab', f.fromPrefab);
    const label = document.createElement('label');
    label.textContent = f.key;
    label.title = [f.description, f.default !== undefined ? `padrão: ${JSON.stringify(f.default)}` : '', f.fromPrefab ? 'valor do prefab' : '']
      .filter(Boolean)
      .join('\n');
    const commit = (value: unknown) => void this.send({ action: 'set', section, key: f.key, value });
    row.append(label, this.control(f, commit));
    if (f.set) {
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'reset';
      reset.textContent = '↺';
      reset.title = f.fromPrefab || f.default === undefined ? 'Remover o valor do arquivo' : `Voltar ao padrão (${JSON.stringify(f.default)})`;
      reset.onclick = () => commit(null);
      row.append(reset);
    }
    return row;
  }

  private control(f: InspectorField, commit: (value: unknown) => void): HTMLElement {
    const input = (type: string, value: string) => {
      const el = document.createElement('input');
      el.type = type;
      el.value = value;
      el.name = f.key;
      return el;
    };
    switch (f.kind) {
      case 'number':
      case 'integer': {
        const el = input('number', f.value === undefined ? '' : String(f.value));
        el.step = f.kind === 'integer' ? '1' : 'any';
        if (f.min !== undefined) el.min = String(f.min);
        if (f.max !== undefined) el.max = String(f.max);
        el.onchange = () => commit(el.value === '' ? null : Number(el.value));
        return el;
      }
      case 'boolean': {
        const el = input('checkbox', '');
        el.checked = !!f.value;
        el.onchange = () => commit(el.checked);
        return el;
      }
      case 'enum':
      case 'asset': {
        const el = document.createElement('select');
        el.name = f.key;
        const options = f.kind === 'asset' ? ['', ...(f.options ?? [])] : (f.options ?? []);
        for (const o of options) el.add(new Option(o || '(nenhum)', o, false, o === (f.value ?? '')));
        // A stored value missing from the list (e.g. an asset that was removed) stays visible.
        if (f.value !== undefined && !options.includes(String(f.value))) el.add(new Option(`${f.value} (?)`, String(f.value), false, true));
        el.onchange = () => commit(el.value === '' ? null : el.value);
        return el;
      }
      case 'flags': {
        const box = document.createElement('div');
        box.className = 'flags';
        const value = new Set(Array.isArray(f.value) ? f.value.map(String) : []);
        for (const o of f.options ?? []) {
          const l = document.createElement('label');
          const c = input('checkbox', o);
          c.checked = value.has(o);
          c.onchange = () => commit(Array.from(box.querySelectorAll<HTMLInputElement>('input:checked'), (x) => x.value));
          l.append(c, o);
          box.append(l);
        }
        return box;
      }
      case 'list': {
        const el = input('text', Array.isArray(f.value) ? f.value.join(', ') : '');
        el.placeholder = 'a, b, c';
        el.onchange = () =>
          commit(
            el.value
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean),
          );
        return el;
      }
      case 'color': {
        const box = document.createElement('div');
        box.className = 'color';
        const text = input('text', String(f.value ?? ''));
        text.onchange = () => commit(text.value.trim() === '' ? null : text.value.trim());
        const hex = /^#[0-9a-f]{6}$/i.test(String(f.value)) ? String(f.value) : /^#[0-9a-f]{3}$/i.test(String(f.value)) ? expandHex(String(f.value)) : '#000000';
        const pick = input('color', hex);
        pick.onchange = () => commit(pick.value);
        box.append(pick, text);
        return box;
      }
      case 'json': {
        const el = document.createElement('textarea');
        el.name = f.key;
        el.spellcheck = false;
        const text = f.value === undefined ? '' : JSON.stringify(f.value, null, 2);
        el.value = text;
        el.rows = Math.min(10, Math.max(2, text.split('\n').length));
        el.onchange = () => {
          if (el.value.trim() === '') return commit(null);
          try {
            commit(JSON.parse(el.value));
          } catch (err) {
            this.showMessage(`${f.key}: JSON inválido (${err instanceof Error ? err.message : String(err)})`);
          }
        };
        return el;
      }
      default: {
        const el = input('text', f.value === undefined ? '' : String(f.value));
        el.onchange = () => commit(el.value === '' ? null : el.value);
        return el;
      }
    }
  }

  private addComponent(types: string[]): HTMLElement {
    const el = document.createElement('select');
    el.className = 'inspector-add';
    el.add(new Option('+ Adicionar componente', ''));
    for (const t of types) el.add(new Option(t, t));
    el.onchange = () => {
      if (el.value) void this.send({ action: 'addComponent', type: el.value as never });
      el.value = '';
    };
    return el;
  }
}

function note(text: string) {
  const p = document.createElement('p');
  p.className = 'inspector-note';
  p.textContent = text;
  return p;
}

function badge(text: string) {
  const b = document.createElement('span');
  b.className = 'badge';
  b.textContent = text;
  return b;
}

const expandHex = (h: string) => `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
