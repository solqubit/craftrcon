// Gamerules the panel knows how to show (Java 1.16+), in display order.
// `name` is the camelCase name; `alt` is the snake_case name newer versions
// use after renaming gamerules. The API asks for `name` first, then `alt`.
const snake = (name) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const bool = (name) => ({ name, alt: snake(name), type: 'bool' });
const int = (name) => ({ name, alt: snake(name), type: 'int' });

export const GAMERULES = [
  bool('keepInventory'),
  bool('doDaylightCycle'),
  bool('doWeatherCycle'),
  bool('doMobSpawning'),
  bool('mobGriefing'),
  bool('doFireTick'),
  bool('naturalRegeneration'),
  bool('doInsomnia'),
  bool('doImmediateRespawn'),
  bool('announceAdvancements'),
  bool('showDeathMessages'),
  bool('doEntityDrops'),
  bool('doTileDrops'),
  bool('doMobLoot'),
  bool('fallDamage'),
  bool('fireDamage'),
  bool('drowningDamage'),
  bool('freezeDamage'),
  bool('doPatrolSpawning'),
  bool('doTraderSpawning'),
  bool('doWardenSpawning'),
  bool('forgiveDeadPlayers'),
  bool('universalAnger'),
  bool('disableRaids'),
  bool('commandBlockOutput'),
  bool('logAdminCommands'),
  bool('sendCommandFeedback'),
  bool('reducedDebugInfo'),
  bool('spectatorsGenerateChunks'),
  bool('doLimitedCrafting'),
  bool('disableElytraMovementCheck'),
  int('randomTickSpeed'),
  int('spawnRadius'),
  int('playersSleepingPercentage'),
  int('maxEntityCramming'),
  int('maxCommandChainLength'),
];
