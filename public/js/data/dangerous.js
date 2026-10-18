// Commands that ask for confirmation before running, until the admin edits the
// list. Pure browser module: the backend imports it for the same default, and
// the UI restores it by PUTting this list.
export const DEFAULT_DANGEROUS_COMMANDS = Object.freeze([
  'stop',
  'op',
  'deop',
  'ban-ip',
  'kill @e',
  'whitelist off',
  'difficulty',
]);
