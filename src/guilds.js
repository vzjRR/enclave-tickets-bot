require('dotenv').config();

// Prints the servers this bot is in, with their ids, so GUILD_ID can be filled
// in without hunting through the Discord client. Uses REST only -- no gateway
// connection, so it is safe to run while the bot is live.

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN is required in .env');
  process.exit(1);
}

(async () => {
  const response = await fetch('https://discord.com/api/v10/users/@me/guilds', {
    headers: { Authorization: `Bot ${token}` }
  });

  if (!response.ok) {
    console.error(`Discord returned ${response.status}: ${await response.text()}`);
    process.exit(1);
  }

  const guilds = await response.json();

  if (!guilds.length) {
    console.log('This bot is not in any server yet. Invite it first.');
    return;
  }

  console.log(`In ${guilds.length} server(s):\n`);
  for (const guild of guilds) {
    console.log(`  ${guild.id}   ${guild.name}`);
  }
  console.log('\nSet GUILD_ID in .env to register slash commands there instantly.');
})();
