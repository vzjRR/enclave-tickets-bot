require('dotenv').config();

const {
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits
} = require('discord.js');

// Every command is guild-only. In a DM interaction.guild is null and the ticket
// handlers have nothing to operate on, so refuse them at registration time.
const guildOnly = [InteractionContextType.Guild];

const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Setup the Enclave RP ticket panel')
    .setContexts(guildOnly)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('quick-setup')
    .setDescription('Create the ticket categories, staff role and panel automatically')
    .setContexts(guildOnly)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addRoleOption((option) =>
      option
        .setName('staff_role')
        .setDescription('Staff role to give ticket access (default: create "Ticket Staff")')
    )
    .addChannelOption((option) =>
      option
        .setName('panel_channel')
        .setDescription('Channel to post the panel in (default: create #tickets)')
        .addChannelTypes(ChannelType.GuildText)
    )
    .addBooleanOption((option) =>
      option
        .setName('separate_categories')
        .setDescription('One category per section instead of a single shared category')
    ),
  new SlashCommandBuilder()
    .setName('ticket-panel')
    .setDescription('Resend the saved ticket panel in this channel')
    .setContexts(guildOnly)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('ticket-section-add')
    .setDescription('Add a new ticket section to the saved panel')
    .setContexts(guildOnly)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('tickets-refresh')
    .setDescription('Refresh all ticket channels and controls')
    .setContexts(guildOnly)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('ticket-admin')
    .setDescription('Open the private admin panel for the current ticket')
    .setContexts(guildOnly)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder()
    .setName('ticket-close')
    .setDescription('Close the current ticket')
    .setContexts(guildOnly),
  new SlashCommandBuilder()
    .setName('ticket-add')
    .setDescription('Add a member to the current ticket')
    .setContexts(guildOnly)
    .addUserOption((option) =>
      option.setName('user').setDescription('Member to add').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('ticket-remove')
    .setDescription('Remove a member from the current ticket')
    .setContexts(guildOnly)
    .addUserOption((option) =>
      option.setName('user').setDescription('Member to remove').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('ticket-rename')
    .setDescription('Rename the current ticket')
    .setContexts(guildOnly)
    .addStringOption((option) =>
      option.setName('name').setDescription('New channel name').setRequired(true).setMaxLength(80)
    )
].map((command) => command.toJSON());

async function main() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID;
  const guildId = process.env.GUILD_ID;

  if (!token || !clientId) {
    throw new Error('DISCORD_TOKEN and CLIENT_ID are required in .env');
  }

  const rest = new REST({ version: '10' }).setToken(token);

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log(`Registered ${commands.length} guild commands for ${guildId}`);
    return;
  }

  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log(`Registered ${commands.length} global commands`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
