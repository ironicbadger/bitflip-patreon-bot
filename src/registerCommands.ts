import "dotenv/config";
import { REST, Routes } from "discord.js";
import { config } from "./config";
import { patreonCommand } from "./commands";

async function main(): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  await rest.put(Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId), {
    body: [patreonCommand.toJSON()]
  });
  console.log(`Registered /patreon commands for guild ${config.discordGuildId}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
