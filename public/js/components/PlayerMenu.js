// The actions menu of one player row: a button that opens a list of actions.
// Keyboard: Enter/Space/↓ open it, ↑/↓/Home/End move, Escape closes and gives
// the focus back to the button, Tab closes. A click outside closes it too.
import { html, useEffect, useRef, useState } from '../../vendor/htm-preact.js';
import { t } from '../i18n.js';
import { Icon } from './Icon.js';

// Groups of actions, each under a small heading. The everyday actions (message,
// teleport, gamemode, give) are also quick buttons on the player card.
const GROUPS = [
  {
    key: 'player',
    items: [
      { action: 'tell', icon: 'message' },
      { action: 'teleport', icon: 'teleport' },
      { action: 'gamemode', icon: 'gamepad' },
      { action: 'give', icon: 'gift' },
    ],
  },
  {
    key: 'permissions',
    items: [
      { action: 'op', icon: 'crown' },
      { action: 'deop', icon: 'shieldOff' },
      { action: 'whitelistAdd', icon: 'userPlus' },
      { action: 'whitelistRemove', icon: 'userMinus' },
    ],
  },
  {
    key: 'moderation',
    items: [
      { action: 'kick', icon: 'logout', danger: true },
      { action: 'ban', icon: 'ban', danger: true },
    ],
  },
];

let nextId = 1;

// `onSelect(action)` runs after the menu closed and the button got the focus
// back, so a dialog opened by it returns the focus to the button when it ends.
export function PlayerMenu({ name, disabled = false, onSelect }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const menuId = useRef(`player-menu-${nextId++}`).current;

  const items = () => [...(menuRef.current?.querySelectorAll('[role="menuitem"]') ?? [])];

  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function close(refocus) {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  }

  function onButtonKeyDown(event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
    }
  }

  function onMenuKeyDown(event) {
    const list = items();
    const at = list.indexOf(document.activeElement);
    let target = null;
    if (event.key === 'ArrowDown') target = list[(at + 1) % list.length];
    else if (event.key === 'ArrowUp') target = list[(at - 1 + list.length) % list.length];
    else if (event.key === 'Home') target = list[0];
    else if (event.key === 'End') target = list.at(-1);
    else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    } else if (event.key === 'Tab') {
      close(false);
      return;
    }
    if (target) {
      event.preventDefault();
      target.focus();
    }
  }

  function choose(action) {
    close(true);
    onSelect(action);
  }

  return html`<div class="pl-menu" ref=${rootRef}>
    <button
      ref=${buttonRef}
      type="button"
      class="icon-btn"
      aria-haspopup="menu"
      aria-expanded=${open ? 'true' : 'false'}
      aria-controls=${open ? menuId : undefined}
      aria-label=${t('players.menu.label', { name })}
      title=${disabled ? t('players.invalidName') : undefined}
      disabled=${disabled}
      onClick=${() => setOpen(!open)}
      onKeyDown=${onButtonKeyDown}
    >
      <${Icon} name="more" />
    </button>
    ${open &&
    html`<div id=${menuId} ref=${menuRef} class="pl-menu-list" role="menu" aria-label=${t('players.menu.label', { name })} onKeyDown=${onMenuKeyDown}>
      ${GROUPS.map(
        (group, index) => html`${index > 0 && html`<div class="pl-menu-sep" role="separator"></div>`}
          <div class="pl-menu-heading" aria-hidden="true">${t(`players.groups.${group.key}`)}</div>
          ${group.items.map(
            ({ action, icon, danger }) => html`<button
              key=${action}
              type="button"
              role="menuitem"
              tabindex="-1"
              class=${`pl-menu-item ${danger ? 'pl-menu-danger' : ''}`}
              onClick=${() => choose(action)}
            >
              <${Icon} name=${icon} size=${15} />
              <span>${t(`players.actions.${action}`)}</span>
            </button>`,
          )}`,
      )}
    </div>`}
  </div>`;
}
