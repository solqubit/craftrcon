// Starts the fake Minecraft server on the default ports for UI development.
import { startFakeMinecraft } from '../test/fixtures/fakeMinecraft.js';

const fake = await startFakeMinecraft({
  password: 'dev',
  rconPort: 25575,
  gamePort: 25565,
  strict: true, // frames packets like vanilla, so protocol mistakes show up in the UI
});
console.log(`Fake Minecraft: RCON ${fake.rconPort} (password "dev"), game ${fake.gamePort}`);

process.on('SIGINT', async () => {
  await fake.close();
  process.exit(0);
});
