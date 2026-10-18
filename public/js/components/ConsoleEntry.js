// One run of a command in a console log: the command line (time, origin tag,
// duration or spinner) and its output below. Shared by the Console page and
// the Dashboard's mini console, which style it with the same .cl-* classes.
import { html } from '../../vendor/htm-preact.js';
import { t } from '../i18n.js';
import { errorKey, formatTime, isErrorOutput, splitOutput } from '../lib/console.js';
import { McText } from './McText.js';

export function Entry({ entry }) {
  const time = formatTime(entry.ts);
  const tagged = entry.origin === 'task' || entry.origin === 'ui';
  const failed = !entry.pending && !entry.ok;
  const lines = !entry.pending && entry.ok && entry.output ? splitOutput(entry.output) : [];
  const errorReply = lines.length > 0 && isErrorOutput(entry.output);

  return html`<div class="cl-entry">
    <div class="cl-line cl-cmd">
      <span class="cl-ts">${time}</span>
      <span class="cl-body"><span class="cl-prompt" aria-hidden="true">›</span>${entry.command}</span>
      ${tagged && html`<span class="cl-tag" title=${t(`console.originTitle.${entry.origin}`)}>${t(`console.origin.${entry.origin}`)}</span>`}
      ${entry.pending
        ? html`<span class="spinner cl-spinner" aria-hidden="true"></span><span class="sr-only">${t('console.running')}</span>`
        : entry.durationMs != null && html`<span class="cl-meta">${t('console.durationMs', { ms: entry.durationMs })}</span>`}
    </div>
    ${failed &&
    html`<div class="cl-line cl-err">
      <span class="cl-ts" aria-hidden="true"></span>
      <span class="cl-body">${t(errorKey(entry.error))}</span>
    </div>`}
    ${lines.map(
      (line) => html`<div class=${`cl-line ${errorReply ? 'cl-err' : ''}`}>
        <span class="cl-ts" aria-hidden="true"></span>
        <span class="cl-body"><${McText} text=${line} /></span>
      </div>`,
    )}
  </div>`;
}
