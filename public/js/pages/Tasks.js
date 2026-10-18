// Tasks: commands the panel runs on a schedule for the active server.
//
// The list (GET /tasks) refreshes every 30 s while the tab is visible, so the
// "next run" and "last run" stay fresh. Each task has an enabled switch (an
// immediate PUT { enabled }), "Run now", Edit and Delete. The editor is a
// modal: a schedule (every N minutes or daily at a time) and an ordered list
// of steps (a command or a wait) that can be reordered, with the same limits
// the API checks (lib/tasks.js). New tasks can start from a template.
//
// Tasks run unattended, so a step on the "dangerous" list is not confirmed at
// run time: the editor only warns about it.
import { html, useEffect, useRef, useState } from '../../vendor/htm-preact.js';
import { api } from '../api.js';
import { t } from '../i18n.js';
import { TASK_TEMPLATES } from '../data/taskTemplates.js';
import { DEFAULT_DANGEROUS_COMMANDS } from '../data/dangerous.js';
import { isDangerous } from '../lib/dangerous.js';
import { usePolling } from '../lib/polling.js';
import {
  MAX_STEPS, MAX_NAME,
  applyTemplate, draftFromTask, draftToBody, emptyDraft, errorKey, formatAbsolute, formatLastRun,
  formatNextRun, formatTrigger, moveStep, newStep, removeStep, validateDraft, withoutStepErrors,
} from '../lib/tasks.js';
import { ActiveServer } from '../components/ActiveServer.js';
import { Confirm } from '../components/Confirm.js';
import { Empty } from '../components/Empty.js';
import { Icon } from '../components/Icon.js';
import { Modal } from '../components/Modal.js';
import { toast } from '../components/Toast.js';

const POLL_MS = 30_000;

// A short reason for a failed request.
const reasonText = (code) => (code === 'network_error' ? t('errors.network') : t('tasks.toast.failed'));

function Loading() {
  return html`<div class="page-loading" role="status">
    <span class="spinner spinner-lg" aria-hidden="true"></span>
    <span>${t('common.loading')}</span>
  </div>`;
}

// ---------- Editor ----------

function FieldError({ id, field, errors }) {
  const code = errors[field];
  return code ? html`<p id=${id} class="field-error" role="alert">${t(errorKey(field, code))}</p>` : null;
}

function StepRow({ step, index, total, dangerous, error, onChange, onMove, onRemove, disabled }) {
  const n = index + 1;
  const inputId = `tk-step-${step.key}`;
  const errorId = `${inputId}-error`;
  const invalid = error ? 'true' : undefined;
  const iconButton = (name, label, onClick, extra = {}) => html`<button
    type="button"
    class="icon-btn"
    aria-label=${label}
    title=${label}
    disabled=${disabled || extra.disabled}
    data-key=${step.key}
    data-act=${name}
    onClick=${onClick}
  >
    <${Icon} name=${extra.icon ?? name} size=${16} />
  </button>`;

  return html`<li class="tk-step">
    <span class="tk-step-n" aria-hidden="true">${n}</span>
    <div class="tk-step-main">
      ${step.type === 'wait'
        ? html`<div class="tk-wait">
            <label class="tk-wait-label" for=${inputId}>${t('tasks.editor.wait')}</label>
            <input
              id=${inputId}
              class="input mono tk-wait-input"
              type="text"
              inputmode="numeric"
              value=${step.minutes}
              aria-label=${t('tasks.editor.waitNamed', { n })}
              aria-invalid=${invalid}
              aria-describedby=${error ? errorId : undefined}
              data-input=${step.key}
              autocomplete="off"
              onInput=${(e) => onChange({ minutes: e.currentTarget.value })}
            />
            <span class="tk-wait-unit">${t('tasks.editor.waitUnit')}</span>
          </div>`
        : html`<div class="tk-command">
            <input
              id=${inputId}
              class="input mono"
              type="text"
              value=${step.command}
              placeholder=${t('tasks.editor.commandPlaceholder')}
              aria-label=${t('tasks.editor.commandNamed', { n })}
              aria-invalid=${invalid}
              aria-describedby=${error ? errorId : undefined}
              data-input=${step.key}
              autocomplete="off"
              autocapitalize="off"
              spellcheck=${false}
              onInput=${(e) => onChange({ command: e.currentTarget.value })}
            />
            ${dangerous &&
            html`<span class="pill pill-warn tk-danger" title=${t('tasks.editor.dangerousTitle')}>
              <${Icon} name="warn" size=${13} />${t('tasks.editor.dangerous')}
            </span>`}
          </div>`}
      ${error && html`<p id=${errorId} class="field-error" role="alert">${t(errorKey(`steps.${index}`, error))}</p>`}
    </div>
    <div class="tk-step-actions">
      ${iconButton('up', t('tasks.editor.moveUp', { n }), () => onMove(-1), { disabled: index === 0, icon: 'arrowUp' })}
      ${iconButton('down', t('tasks.editor.moveDown', { n }), () => onMove(1), { disabled: index === total - 1, icon: 'arrowDown' })}
      ${iconButton('remove', t('tasks.editor.remove', { n }), onRemove, { icon: 'trash' })}
    </div>
  </li>`;
}

const SHOWN_FIELDS = new Set(['name', 'intervalMinutes', 'dailyTime', 'steps']);

function TaskEditor({ serverId, task, dangerous, onClose, onSaved }) {
  const editing = task !== null;
  const [draft, setDraft] = useState(() => (editing ? draftFromTask(task) : emptyDraft()));
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null); // translation key
  const formRef = useRef(null);
  const focusNext = useRef(null); // selectors to try after the next render

  // Moves the focus once a change has rendered (a step that moved or was
  // added, or the first field with an error).
  useEffect(() => {
    if (focusNext.current === null) return;
    const form = formRef.current;
    const wanted = focusNext.current;
    focusNext.current = null;
    for (const selector of wanted) {
      const el = form?.querySelector(selector);
      if (el && !el.disabled) {
        el.focus();
        return;
      }
    }
  });

  const clearError = (field) => setErrors((e) => (field in e ? Object.fromEntries(Object.entries(e).filter(([k]) => k !== field)) : e));
  const setField = (field, value) => {
    setDraft((d) => ({ ...d, [field]: value }));
    clearError(field);
  };
  const setSteps = (steps) => setDraft((d) => ({ ...d, steps }));

  function changeStep(index, patch) {
    setSteps(draft.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)));
    clearError(`steps.${index}`);
  }

  function move(index, delta) {
    const key = draft.steps[index].key;
    const moved = moveStep(draft.steps, index, delta);
    if (moved === draft.steps) return;
    setSteps(moved);
    setErrors(withoutStepErrors);
    // The moved row's own button, or its twin when it reached an end.
    focusNext.current = [`[data-key="${key}"][data-act="${delta < 0 ? 'up' : 'down'}"]`, `[data-key="${key}"][data-act="${delta < 0 ? 'down' : 'up'}"]`];
  }

  function remove(index) {
    const neighbour = draft.steps[index + 1] ?? draft.steps[index - 1];
    setSteps(removeStep(draft.steps, index));
    setErrors(withoutStepErrors);
    focusNext.current = [neighbour ? `[data-input="${neighbour.key}"]` : '[data-add="command"]', '[data-add="command"]'];
  }

  function add(type) {
    if (draft.steps.length >= MAX_STEPS) return;
    const step = newStep(type);
    setSteps([...draft.steps, step]);
    clearError('steps');
    focusNext.current = [`[data-input="${step.key}"]`];
  }

  function pickTemplate(template) {
    setDraft((d) => applyTemplate(d, template));
    setErrors({});
    setSaveError(null);
  }

  async function save() {
    if (saving) return;
    const found = validateDraft(draft);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      setSaveError(null);
      focusNext.current = ['[aria-invalid="true"]'];
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const path = `/api/servers/${serverId}/tasks${editing ? `/${task.id}` : ''}`;
      const saved = await api(path, { method: editing ? 'PUT' : 'POST', body: draftToBody(draft) });
      onSaved(saved, editing);
      return;
    } catch (err) {
      if (err.status === 400 && err.body?.fields) {
        setErrors(err.body.fields);
        focusNext.current = ['[aria-invalid="true"]'];
      } else if (err.status === 404) setSaveError('tasks.toast.gone');
      else if (err.status !== 401) setSaveError(err.code === 'network_error' ? 'errors.network' : 'tasks.editor.saveFailed');
    }
    setSaving(false);
  }

  const interval = draft.triggerType === 'interval';
  const hasOtherErrors = Object.keys(errors).some((field) => !SHOWN_FIELDS.has(field) && !field.startsWith('steps.'));
  const footer = html`
    <button type="button" class="btn btn-secondary" onClick=${onClose} disabled=${saving}>${t('common.cancel')}</button>
    <button type="button" class="btn btn-primary" onClick=${save} disabled=${saving} aria-busy=${saving ? 'true' : undefined}>
      ${saving && html`<span class="spinner" aria-hidden="true"></span>`}${editing ? t('tasks.editor.save') : t('tasks.editor.create')}
    </button>
  `;

  return html`<${Modal} title=${editing ? t('tasks.editor.editTitle') : t('tasks.editor.addTitle')} onClose=${onClose} busy=${saving} footer=${footer} size="lg">
    <form
      ref=${formRef}
      class="tk-form"
      noValidate
      onSubmit=${(event) => {
        event.preventDefault();
        save();
      }}
    >
      ${!editing &&
      html`<div class="field" role="group" aria-labelledby="tk-templates-label">
        <span id="tk-templates-label" class="label">${t('tasks.editor.templates')}</span>
        <div class="tk-templates">
          ${TASK_TEMPLATES.map(
            (template) => html`<button key=${template.id} type="button" class="btn btn-secondary btn-sm" disabled=${saving} onClick=${() => pickTemplate(template)}>
              ${t(template.nameKey)}
            </button>`,
          )}
        </div>
        <p class="hint">${t('tasks.editor.templatesHint')}</p>
      </div>`}

      <div class="field">
        <label class="label" for="tk-name">${t('tasks.editor.name')}</label>
        <input
          id="tk-name"
          class="input"
          type="text"
          value=${draft.name}
          maxlength=${MAX_NAME + 20}
          placeholder=${t('tasks.editor.namePlaceholder')}
          aria-invalid=${errors.name ? 'true' : undefined}
          aria-describedby=${errors.name ? 'tk-name-error' : undefined}
          autocomplete="off"
          autofocus
          onInput=${(e) => setField('name', e.currentTarget.value)}
        />
        <${FieldError} id="tk-name-error" field="name" errors=${errors} />
      </div>

      <div class="tk-trigger">
        <div class="field">
          <label class="label" for="tk-trigger">${t('tasks.editor.trigger')}</label>
          <select id="tk-trigger" class="select" value=${draft.triggerType} onChange=${(e) => setField('triggerType', e.currentTarget.value)}>
            <option value="interval">${t('tasks.editor.triggerInterval')}</option>
            <option value="daily">${t('tasks.editor.triggerDaily')}</option>
          </select>
        </div>
        ${interval
          ? html`<div class="field">
              <label class="label" for="tk-interval">${t('tasks.editor.interval')}</label>
              <input
                id="tk-interval"
                class="input mono"
                type="text"
                inputmode="numeric"
                value=${draft.intervalMinutes}
                aria-invalid=${errors.intervalMinutes ? 'true' : undefined}
                aria-describedby=${errors.intervalMinutes ? 'tk-interval-error' : 'tk-interval-hint'}
                autocomplete="off"
                onInput=${(e) => setField('intervalMinutes', e.currentTarget.value)}
              />
              ${errors.intervalMinutes
                ? html`<${FieldError} id="tk-interval-error" field="intervalMinutes" errors=${errors} />`
                : html`<p id="tk-interval-hint" class="hint">${t('tasks.editor.intervalHint')}</p>`}
            </div>`
          : html`<div class="field">
              <label class="label" for="tk-daily">${t('tasks.editor.daily')}</label>
              <input
                id="tk-daily"
                class="input mono"
                type="time"
                value=${draft.dailyTime}
                aria-invalid=${errors.dailyTime ? 'true' : undefined}
                aria-describedby=${errors.dailyTime ? 'tk-daily-error' : 'tk-daily-hint'}
                onInput=${(e) => setField('dailyTime', e.currentTarget.value)}
              />
              ${errors.dailyTime
                ? html`<${FieldError} id="tk-daily-error" field="dailyTime" errors=${errors} />`
                : html`<p id="tk-daily-hint" class="hint">${t('tasks.editor.dailyHint')}</p>`}
            </div>`}
      </div>

      <div class="field">
        <span class="label" id="tk-steps-label">${t('tasks.editor.steps')}</span>
        <p class="hint">${t('tasks.editor.stepsHint')}</p>
        <ol class="tk-steps" aria-labelledby="tk-steps-label">
          ${draft.steps.map(
            (step, i) => html`<${StepRow}
              key=${step.key}
              step=${step}
              index=${i}
              total=${draft.steps.length}
              dangerous=${step.type === 'command' && isDangerous(step.command, dangerous)}
              error=${errors[`steps.${i}`]}
              disabled=${saving}
              onChange=${(patch) => changeStep(i, patch)}
              onMove=${(delta) => move(i, delta)}
              onRemove=${() => remove(i)}
            />`,
          )}
        </ol>
        <${FieldError} id="tk-steps-error" field="steps" errors=${errors} />
        <div class="tk-add">
          <button type="button" class="btn btn-secondary btn-sm" data-add="command" disabled=${saving || draft.steps.length >= MAX_STEPS} onClick=${() => add('command')}>
            <${Icon} name="plus" size=${14} />${t('tasks.editor.addCommand')}
          </button>
          <button type="button" class="btn btn-secondary btn-sm" data-add="wait" disabled=${saving || draft.steps.length >= MAX_STEPS} onClick=${() => add('wait')}>
            <${Icon} name="plus" size=${14} />${t('tasks.editor.addWait')}
          </button>
          <span class="hint tk-count">${draft.steps.length}/${MAX_STEPS}</span>
        </div>
        <p class="hint">${t('tasks.editor.unattended')}</p>
      </div>

      ${(saveError || hasOtherErrors) &&
      html`<div class="alert alert-error" role="alert">
        <${Icon} name="error" size=${16} /><span>${t(saveError ?? 'tasks.errors.invalid')}</span>
      </div>`}
    </form>
  </${Modal}>`;
}

// ---------- List ----------

function TaskItem({ task, now, busy, onToggle, onRun, onEdit, onDelete }) {
  const nameId = `tk-name-${task.id}`;
  const steps = task.steps.length;
  return html`<li class=${`card tk-item ${task.enabled ? '' : 'tk-item-off'}`}>
    <button
      type="button"
      role="switch"
      class="wd-switch tk-switch"
      aria-checked=${task.enabled ? 'true' : 'false'}
      aria-labelledby=${nameId}
      title=${t('tasks.toggleNamed', { name: task.name })}
      disabled=${busy}
      onClick=${() => onToggle(task)}
    ></button>
    <div class="tk-item-main">
      <h2 id=${nameId} class="tk-item-name">${task.name}</h2>
      <p class="tk-item-meta">
        <span class="tk-trigger-text">${formatTrigger(task)}</span>
        <span class="tk-sep" aria-hidden="true">·</span>
        <span><span class="tk-meta-label">${t('tasks.meta.next')}:</span>
          ${task.enabled && task.nextRunAt !== null
            ? html`<time class="tk-time" datetime=${new Date(task.nextRunAt).toISOString()} title=${formatAbsolute(task.nextRunAt)}>${formatNextRun(task.nextRunAt, now)}</time>`
            : html`<span class="tk-time">${t('tasks.meta.paused')}</span>`}
        </span>
        <span class="tk-sep" aria-hidden="true">·</span>
        <span><span class="tk-meta-label">${t('tasks.meta.last')}:</span>
          ${task.lastRunAt !== null
            ? html`<time class="tk-time" datetime=${new Date(task.lastRunAt).toISOString()} title=${formatAbsolute(task.lastRunAt)}>${formatLastRun(task.lastRunAt, now)}</time>`
            : html`<span class="tk-time">${formatLastRun(null, now)}</span>`}
        </span>
        <span class="tk-sep" aria-hidden="true">·</span>
        <span>${steps === 1 ? t('tasks.stepsOne') : t('tasks.steps', { count: steps })}</span>
      </p>
    </div>
    <div class="tk-item-actions">
      <button type="button" class="btn btn-secondary btn-sm" disabled=${busy} aria-label=${t('tasks.runNamed', { name: task.name })} onClick=${() => onRun(task)}>
        <${Icon} name="play" size=${14} />${t('tasks.run')}
      </button>
      <button type="button" class="icon-btn" aria-label=${t('tasks.editNamed', { name: task.name })} title=${t('tasks.edit')} onClick=${() => onEdit(task)}>
        <${Icon} name="edit" size=${16} />
      </button>
      <button type="button" class="icon-btn tk-delete" aria-label=${t('tasks.deleteNamed', { name: task.name })} title=${t('common.delete')} onClick=${() => onDelete(task)}>
        <${Icon} name="trash" size=${16} />
      </button>
    </div>
  </li>`;
}

function TasksView({ server }) {
  const [tasks, setTasks] = useState(null); // null until loaded
  const [error, setError] = useState(null); // code of the last failed load
  const [dangerous, setDangerous] = useState(DEFAULT_DANGEROUS_COMMANDS);
  const [editing, setEditing] = useState(undefined); // undefined: closed, null: new, task: edit
  const [deleting, setDeleting] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [busy, setBusy] = useState(() => new Set()); // ids with a request in flight
  const base = `/api/servers/${server.id}/tasks`;

  async function load(isCurrent = () => true) {
    try {
      const list = await api(base);
      if (!isCurrent()) return;
      setTasks(Array.isArray(list) ? list : []);
      setError(null);
    } catch (err) {
      if (isCurrent() && err.status !== 401) setError(err.status === 404 ? 'not_found' : err.code);
    }
  }
  usePolling(load, POLL_MS, [server.id]);

  useEffect(() => {
    api('/api/settings/dangerous-commands')
      .then((list) => Array.isArray(list) && setDangerous(list))
      .catch(() => {}); // keep the defaults: better one warning too many
  }, []);

  const markBusy = (id, on) =>
    setBusy((set) => {
      const next = new Set(set);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  // Toast for a failed action; a task that is gone refreshes the list.
  function failed(err) {
    if (err.status === 401) return;
    if (err.status === 404) {
      toast(t('tasks.toast.gone'), { type: 'error' });
      load();
    } else toast(reasonText(err.code), { type: 'error' });
  }

  async function toggle(task) {
    markBusy(task.id, true);
    try {
      const saved = await api(`${base}/${task.id}`, { method: 'PUT', body: { enabled: !task.enabled } });
      setTasks((list) => list?.map((x) => (x.id === saved.id ? saved : x)) ?? list);
      toast(t(saved.enabled ? 'tasks.toast.enabled' : 'tasks.toast.disabled', { name: saved.name }));
    } catch (err) {
      failed(err);
    }
    markBusy(task.id, false);
  }

  async function run(task) {
    markBusy(task.id, true);
    try {
      await api(`${base}/${task.id}/run`, { method: 'POST' });
      toast(t('tasks.toast.started', { name: task.name }), { type: 'info' });
      load();
    } catch (err) {
      if (err.status === 409) toast(t('tasks.toast.alreadyRunning', { name: task.name }), { type: 'warn' });
      else failed(err);
    }
    markBusy(task.id, false);
  }

  async function confirmDelete() {
    const task = deleting;
    setDeleteBusy(true);
    try {
      await api(`${base}/${task.id}`, { method: 'DELETE' });
      setTasks((list) => list?.filter((x) => x.id !== task.id) ?? list);
      toast(t('tasks.toast.deleted', { name: task.name }));
      setDeleting(null);
    } catch (err) {
      setDeleting(null);
      failed(err);
    }
    setDeleteBusy(false);
  }

  function saved(task, wasEditing) {
    setEditing(undefined);
    setTasks((list) => {
      const rest = (list ?? []).filter((x) => x.id !== task.id);
      return [...rest, task].sort((a, b) => a.id - b.id);
    });
    toast(t(wasEditing ? 'tasks.toast.saved' : 'tasks.toast.created', { name: task.name }));
  }

  const newButton = html`<button type="button" class="btn btn-primary" onClick=${() => setEditing(null)}>
    <${Icon} name="plus" size=${16} />${t('tasks.add')}
  </button>`;

  let body;
  if (tasks === null && error === null) body = html`<${Loading} />`;
  else if (tasks === null) {
    body = html`<${Empty}
      icon="error"
      title=${t('tasks.loadFailed.title')}
      message=${reasonText(error)}
      action=${html`<button type="button" class="btn btn-secondary" onClick=${() => { setError(null); load(); }}>${t('common.retry')}</button>`}
    />`;
  } else if (tasks.length === 0) {
    body = html`<${Empty} icon="tasks" title=${t('tasks.empty.title')} message=${t('tasks.empty.message')} action=${newButton} />`;
  } else {
    const now = Date.now();
    body = html`<ul class="tk-list">
      ${tasks.map(
        (task) => html`<${TaskItem}
          key=${task.id}
          task=${task}
          now=${now}
          busy=${busy.has(task.id)}
          onToggle=${toggle}
          onRun=${run}
          onEdit=${setEditing}
          onDelete=${setDeleting}
        />`,
      )}
    </ul>`;
  }

  return html`<div class="page tk">
    <header class="page-head">
      <div>
        <h1 class="page-title">${t('nav.tasks')}</h1>
        <p class="page-subtitle">${t('tasks.subtitle', { name: server.name })}</p>
      </div>
      ${tasks !== null && tasks.length > 0 && newButton}
    </header>
    <p class="tk-note"><${Icon} name="info" size=${16} /><span>${t('tasks.note')}</span></p>
    ${tasks !== null && error !== null &&
    html`<div class="alert alert-warn" role="alert">
      <${Icon} name="warn" size=${16} /><span>${t('tasks.refreshFailed', { reason: reasonText(error) })}</span>
    </div>`}
    ${body}
    ${editing !== undefined &&
    html`<${TaskEditor}
      serverId=${server.id}
      task=${editing}
      dangerous=${dangerous}
      onClose=${() => setEditing(undefined)}
      onSaved=${saved}
    />`}
    ${deleting &&
    html`<${Confirm}
      title=${t('tasks.delete.title', { name: deleting.name })}
      message=${t('tasks.delete.message')}
      confirmLabel=${t('tasks.delete.confirm')}
      danger
      busy=${deleteBusy}
      onConfirm=${confirmDelete}
      onCancel=${() => setDeleting(null)}
    />`}
  </div>`;
}

export function Tasks() {
  return html`<${ActiveServer} titleKey="nav.tasks" view=${(server) => html`<${TasksView} key=${server.id} server=${server} />`} />`;
}
