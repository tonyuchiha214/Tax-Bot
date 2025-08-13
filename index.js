import { Client, GatewayIntentBits } from 'discord.js';
import 'dotenv/config';
import './tax.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on('messageCreate', (message) => {
  if (message.content.toLowerCase() === '!tax') {
    message.reply('📢 Remember to pay your taxes!');
  }
});

client.login(process.env.DISCORD_TOKEN);
