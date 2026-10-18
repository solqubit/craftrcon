// Pure parts of sending a command from a page (Players, Moderation): what the
// server's answer says, which error code a failure maps to, and whether the
// command has to be confirmed first. No DOM, so it can be unit-tested.
import { isDangerous } from './dangerous.js';

// The text the server replied with ('' when it said nothing).
export function commandReply(result) {
  return typeof result?.output === 'string' ? result.output.trim() : '';
}

// The error code of a failed API call (a missing server is 'not_found').
export function failureCode(err) {
  return err?.status === 404 ? 'not_found' : err?.code;
}

// How `command` must be confirmed before it is sent:
//  - { kind: 'dangerous' }: it is on the dangerous list (the generic dialog);
//  - { kind: 'ask', ask }: the page asks with its own dialog (`ask`);
//  - null: send it straight away.
// The dangerous dialog wins when both apply, so nobody confirms twice.
export function confirmationFor(command, dangerous, ask) {
  if (isDangerous(command, dangerous)) return { kind: 'dangerous' };
  if (ask) return { kind: 'ask', ask };
  return null;
}
