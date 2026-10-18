// Starting points offered when creating a scheduled task. The name and any
// chat text (`say`) come from the locale files at the moment a template is
// applied, so a task is created in the language the admin is using:
//   - `nameKey` is the translation key of the task name;
//   - a step with `sayKey` becomes `say <translated text>`; any other command
//     is sent as is.
// Pure data: the editor turns it into a draft (see lib/tasks.js).
export const TASK_TEMPLATES = Object.freeze([
  {
    id: 'saveEvery30',
    nameKey: 'tasks.templates.saveEvery30.name',
    triggerType: 'interval',
    intervalMinutes: 30,
    steps: [{ type: 'command', command: 'save-all' }],
  },
  {
    id: 'autoMessage',
    nameKey: 'tasks.templates.autoMessage.name',
    triggerType: 'interval',
    intervalMinutes: 60,
    steps: [{ type: 'command', sayKey: 'tasks.templates.autoMessage.say' }],
  },
  {
    id: 'restartWarning',
    nameKey: 'tasks.templates.restartWarning.name',
    triggerType: 'daily',
    dailyTime: '04:00',
    steps: [
      { type: 'command', sayKey: 'tasks.templates.restartWarning.in10' },
      { type: 'wait', minutes: 5 },
      { type: 'command', sayKey: 'tasks.templates.restartWarning.in5' },
      { type: 'wait', minutes: 4 },
      { type: 'command', sayKey: 'tasks.templates.restartWarning.in1' },
      { type: 'wait', minutes: 1 },
      { type: 'command', command: 'save-all' },
      { type: 'command', command: 'stop' },
    ],
  },
]);
