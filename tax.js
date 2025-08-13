code_content = """import fs from 'fs';
import path from 'path';
import {
  EmbedBuilder,
  PermissionsBitField,
  SlashCommandBuilder,
  ChannelType,
} from 'discord.js';

/* -------------------- storage -------------------- */
const DATA_DIR  = path.resolve('data');
const ECON_PATH = path.join(DATA_DIR, 'economy.json');

function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ECON_PATH)) {
    fs.writeFileSync(
      ECON_PATH,
      JSON.stringify({ users: {}, taxes: {}, taxPending: {} }, null, 2)
    );
  }
}
function loadData() {
  ensureData();
  return JSON.parse(fs.readFileSync(ECON_PATH, 'utf8'));
}
function saveData(d) {
  fs.writeFileSync(ECON_PATH, JSON.stringify(d, null, 2));
}

/* -------------------- utils -------------------- */
const FT_BLUE = 0x5865F2;

const isCollectorOrAdmin = (member, collectorId) =>
  (collectorId && member.id === collectorId) ||
  member.permissions.has(PermissionsBitField.Flags.Administrator);

// Prefer image/GIF so it renders inside the embed. Fall back to link unfurl.
async function resolveDirectMediaKinds(url) {
  try {
    const u = new URL(url);
    // Tenor: scrape og:image / og:video
    if (u.hostname.includes('tenor.com')) {
      const r = await fetch(url);
      const html = await r.text();
      const mImg = html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
      const mVid = html.match(/property=["']og:video(?:\\:secure_url)?["'][^>]*content=["']([^"']+)["']/i);
      return {
        image: mImg?.[1]?.replace(/&amp;/g, '&') || null,
        video: mVid?.[1]?.replace(/&amp;/g, '&') || null,
      };
    }
    // Direct CDN (gif/jpg/png/webp or mp4/webm/mov)
    const p = u.pathname.toLowerCase();
    const isImg = /\\.(gif|png|jpe?g|webp)$/.test(p);
    const isVid = /\\.(mp4|webm|mov)$/.test(p);
    return { image: isImg ? url : null, video: isVid ? url : null };
  } catch {
    return { image: null, video: null };
  }
}
function extFromUrlOrType(url, contentType = '') {
  const low = (new URL(url)).pathname.toLowerCase();
  if (low.endsWith('.gif') || contentType.includes('gif')) return 'gif';
  if (low.endsWith('.png') || contentType.includes('png')) return 'png';
  if (low.endsWith('.jpg') || low.endsWith('.jpeg') || contentType.includes('jpeg')) return 'jpg';
  if (low.endsWith('.webp') || contentType.includes('webp')) return 'webp';
  if (low.endsWith('.mp4') || contentType.includes('mp4')) return 'mp4';
  if (low.endsWith('.webm') || contentType.includes('webm')) return 'webm';
  if (low.endsWith('.mov') || contentType.includes('quicktime')) return 'mov';
  return 'bin';
}
const isVideoExt = (e) => ['mp4','webm','mov'].includes(e);
const isImageExt = (e) => ['gif','png','jpg','jpeg','webp'].includes(e);

async function prepareEmbedWithAttachment(embed, mediaUrl, basename = 'media', preferImage = true, forceImage = true) {
  async function tryAttach(url, nameBase) {
    try {
      let ct = '';
      try {
        const h = await fetch(url, { method: 'HEAD' });
        ct = h.headers.get('content-type') || '';
      } catch {}
      const res = await fetch(url);
      ct = res.headers.get('content-type') || ct;
      const ab = await res.arrayBuffer();
      const ext = extFromUrlOrType(url, ct);
      const name = ${nameBase}.${ext};
      const buffer = Buffer.from(ab);

      if (!forceImage && isVideoExt(ext)) {
        return { embeds: [embed], files: [{ attachment: buffer, name }] };
      }
      if (isImageExt(ext)) {
        embed.setImage(attachment://${name});
        return { embeds: [embed], files: [{ attachment: buffer, name }] };
      }
      return null;
    } catch {
      return null;
    }
  }

  try {
    const { image, video } = await resolveDirectMediaKinds(mediaUrl);
    const first  = preferImage ? image : video;
    const second = preferImage ? video : image;

    if (first)  { const p = await tryAttach(first,  basename); if (p) return p; }
    if (!forceImage && second) { const p = await tryAttach(second, basename); if (p) return p; }

    return { content: mediaUrl, embeds: [embed] }; // fallback to link unfurl
  } catch {
    return { content: mediaUrl, embeds: [embed] };
  }
}

/* -------------------- public API -------------------- */

// Called from /earn to apply tax + DM seller + swap roles
export async function recordSaleTax({
  client,
  guild,
  sellerId,
  amount,
  percent,
  taxGifUrl,
  paypalName,
  sellerRoleId,
  taxPendingRoleId,
}) {
  const data = loadData();
  data.taxes      ??= {};
  data.taxPending ??= {};

  const tax = Math.ceil(amount * percent);
  data.taxes[sellerId]      = (data.taxes[sellerId] || 0) + tax;
  data.taxPending[sellerId] = (data.taxPending[sellerId] || 0) + tax;
  saveData(data);

  // Role update
  try {
    const m = await guild.members.fetch(sellerId);
    if (sellerRoleId && m.roles.cache.has(sellerRoleId)) {
      await m.roles.remove(sellerRoleId, 'Tax pending proof');
    }
    if (taxPendingRoleId) {
      try { await m.roles.add(taxPendingRoleId); } catch {}
    }
  } catch {}

  // DM seller (put media inside embed like scammer)
  try {
    const u = await client.users.fetch(sellerId);
    const percentLabel = Math.round(percent * 100);
    const totalOwed = data.taxes[sellerId];

    const e = new EmbedBuilder()
      .setTitle('🧾 Tax Notice')
      .setColor(FT_BLUE)
      .setDescription(
        You sold **${amount} :coin:**.\\n +
        Tax (${percentLabel}%): **${tax} :coin:**.\\n +
        **Total owed:** **${totalOwed} :coin:**\\n\\n +
        **How to pay**\\n +
        • PayPal: **${paypalName}**\\n +
        • After paying, reply to this DM with a **Rep screenshot** (payment proof).\\n +
        • Once verified, your **Seller** role will be restored.\\n
      );

    const payload = await prepareEmbedWithAttachment(e, taxGifUrl, 'tax', true, true);
    await u.send(payload);
  } catch {}

  return tax;
}

// Slash command builders (we’ll register these from index.js)
export function buildTaxCommands() {
  return [
    new SlashCommandBuilder()
      .setName('taxes')
      .setDescription('View or clear seller tax.')
      .addSubcommand(sc =>
        sc.setName('view')
          .setDescription('View outstanding tax (self or another user).')
          .addUserOption(o => o.setName('user').setDescription('User (optional)')))
      .addSubcommand(sc =>
        sc.setName('clear')
          .setDescription('Clear tax (admins/collector only).')
          .addUserOption(o => o.setName('user').setDescription('User to clear').setRequired(true))
          .addIntegerOption(o => o.setName('amount').setDescription('Amount to clear (omit to clear all)').setMinValue(1)))
      .addSubcommand(sc =>
        sc.setName('list')
          .setDescription('List everyone with Seller role and their tax owed (admin/collector).')))
      .toJSON(),

    new SlashCommandBuilder()
      .setName('negativeearn')
      .setDescription('Subtract earnings and adjust taxes (staff/collector only).')
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
      .addIntegerOption(o => o.setName('amount').setDescription('Amount to subtract').setRequired(true).setMinValue(1))
      .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false))
      .toJSON(),

    new SlashCommandBuilder()
      .setName('clearearnings')
      .setDescription('Clear a user’s earnings (staff/collector only).')
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
      .addBooleanOption(o => o.setName('resetspent').setDescription('Also reset spent to 0?').setRequired(false))
      .toJSON(),

    new SlashCommandBuilder()
      .setName('taxremind')
      .setDescription('Send tax reminders now (admin/collector).')
      .addUserOption(o => o.setName('user').setDescription('Specific user (optional)'))
      .addBooleanOption(o => o.setName('only_owe').setDescription('Only DM users who owe > 0 (default true)'))
      .toJSON(),
  ];
}

// Handle /taxes, /taxremind, /negativeearn, /clearearnings
export async function handleTaxInteraction(interaction, client, config) {
  const { SELLER_ROLE_ID, TAX_PENDING_ROLE_ID, TAX_COLLECTOR_ID, TAX_PERCENT, TAX_GIF_URL, PAYPAL_NAME } = config;

  const name = interaction.commandName;
  const data = loadData();

  if (name === 'taxes') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'view') {
      const user = interaction.options.getUser('user') || interaction.user;
      const owed = data.taxes?.[user.id] || 0;
      const e = new EmbedBuilder().setTitle('🧾 Tax Balance').setColor(FT_BLUE)
        .setDescription(${user} owes **${owed} :coin:** in total taxes.);
      return interaction.reply({ embeds: [e], ephemeral: true });
    }

    if (sub === 'clear') {
      await interaction.deferReply({ ephemeral: true });
      const caller = await interaction.guild.members.fetch(interaction.user.id);
      if (!isCollectorOrAdmin(caller, TAX_COLLECTOR_ID)) {
        return interaction.editReply('❌ Only admins or the tax collector can clear taxes.');
      }
      const target = interaction.options.getUser('user', true);
      data.taxes      ??= {};
      data.taxPending ??= {};
      const current = data.taxes[target.id] || 0;
      if (current <= 0) return interaction.editReply(${target} has no outstanding tax.);

      const amt = interaction.options.getInteger('amount');
      let cleared = current;
      if (amt && amt > 0 && amt < current) {
        data.taxes[target.id] = current - amt;
        data.taxPending[target.id] = Math.max(0, (data.taxPending[target.id] || 0) - amt);
        cleared = amt;
      } else {
        data.taxes[target.id] = 0;
        delete data.taxPending[target.id];
      }
      saveData(data);

      if ((data.taxes[target.id] || 0) === 0) {
        try {
          const m = await interaction.guild.members.fetch(target.id);
          if (TAX_PENDING_ROLE_ID) { try { await m.roles.remove(TAX_PENDING_ROLE_ID); } catch {} }
          if (SELLER_ROLE_ID)      { try { await m.roles.add(SELLER_ROLE_ID, 'Tax cleared by staff'); } catch {} }
        } catch {}
      }

      const e = new EmbedBuilder()
        .setTitle('✅ Tax Cleared')
        .setColor(FT_BLUE)
        .setDescription(Cleared **${cleared} :coin:** for ${target}.\\nRemaining: **${data.taxes[target.id] || 0} :coin:**);
      return interaction.editReply({ embeds: [e] });
    }

    if (sub === 'list') {
      await interaction.deferReply({ ephemeral: true });
      const caller = await interaction.guild.members.fetch(interaction.user.id);
      if (!isCollectorOrAdmin(caller, TAX_COLLECTOR_ID)) {
        return interaction.editReply('❌ Only admins or the tax collector can list sellers.');
      }

      const guild = await client.guilds.fetch(interaction.guildId);
      const members = await guild.members.fetch();
      const sellers = members.filter(m => SELLER_ROLE_ID && m.roles.cache.has(SELLER_ROLE_ID));
      if (!sellers.size) return interaction.editReply('No members currently have the Seller role.');

      const rows = [];
      for (const m of sellers.values()) {
        rows.push({ id: m.id, tag: m.user.tag, owed: (loadData().taxes?.[m.id] || 0) });
      }
      rows.sort((a,b) => b.owed - a.owed);

      if (rows.length <= 25) {
        const e = new EmbedBuilder()
          .setTitle('📋 Seller Tax List')
          .setColor(FT_BLUE)
          .setDescription(rows.map(r => • <@${r.id}> — **${r.owed} :coin:**).join('\\n'));
        return interaction.editReply({ embeds: [e] });
      } else {
        const header = 'user_id,tag,tax_owed\\n';
        const csv = header + rows.map(r => ${r.id},\\"${r.tag.replace(/"/g,'""')}\\",${r.owed}).join('\\n');
        const buffer = Buffer.from(csv, 'utf8');
        return interaction.editReply({
          content: Found **${rows.length}** sellers.,
          files: [{ attachment: buffer, name: 'seller_tax_list.csv' }],
        });
      }
    }
  }

  if (name === 'negativeearn') {
    await interaction.deferReply({ ephemeral: true });
    const caller = await interaction.guild.members.fetch(interaction.user.id);
    if (!isCollectorOrAdmin(caller, TAX_COLLECTOR_ID)) {
      return interaction.editReply('❌ Only admins or the tax collector can use this.');
    }

    const user   = interaction.options.getUser('user', true);
    const amount = interaction.options.getInteger('amount', true);
    const reason = interaction.options.getString('reason') || 'Adjustment';

    const d = loadData();
    d.users ??= {};
    d.users[user.id] ??= { earned: 0, spent: 0 };
    d.users[user.id].earned = Math.max(0, d.users[user.id].earned - amount);

    const taxDelta = Math.ceil(amount * TAX_PERCENT);
    d.taxes[user.id]      = Math.max(0, (d.taxes[user.id] || 0) - taxDelta);
    d.taxPending[user.id] = Math.max(0, (d.taxPending[user.id] || 0) - taxDelta);
    saveData(d);

    const e = new EmbedBuilder()
      .setTitle('🧮 Earnings Adjusted')
      .setColor(FT_BLUE)
      .setDescription(
        User: ${user}\\n +
        Amount removed: **${amount} :coin:**\\n +
        Tax reduced: **${taxDelta} :coin:**\\n +
        New earned: **${d.users[user.id].earned} :coin:**\\n +
        Tax owed: **${d.taxes[user.id] || 0} :coin:**\\n +
        Reason: ${reason}
      );
    return interaction.editReply({ embeds: [e] });
  }

  if (name === 'clearearnings') {
    await interaction.deferReply({ ephemeral: true });
    const caller = await interaction.guild.members.fetch(interaction.user.id);
    if (!isCollectorOrAdmin(caller, TAX_COLLECTOR_ID)) {
      return interaction.editReply('❌ Only admins or the tax collector can clear earnings.');
    }

    const user = interaction.options.getUser('user', true);
    const resetSpent = interaction.options.getBoolean('resetspent') || false;

    const d = loadData();
    d.users ??= {};
    d.users[user.id] ??= { earned: 0, spent: 0 };
    d.users[user.id].earned = 0;
    if (resetSpent) d.users[user.id].spent = 0;
    saveData(d);

    const e = new EmbedBuilder()
      .setTitle('🧹 Earnings Cleared')
      .setColor(FT_BLUE)
      .setDescription(
        User: ${user}\\nEarned set to **0 :coin.**\\n +
        (resetSpent ? 'Spent also reset to **0 :coin.**' : 'Spent left unchanged.')
      );
    return interaction.editReply({ embeds: [e] });
  }

  if (name === 'taxremind') {
    await interaction.deferReply({ ephemeral: true });
    const caller = await interaction.guild.members.fetch(interaction.user.id);
    if (!isCollectorOrAdmin(caller, TAX_COLLECTOR_ID)) {
      return interaction.editReply('❌ Only admins or the tax collector can use this.');
    }
    const target  = interaction.options.getUser('user');
    const onlyOwe = interaction.options.getBoolean('only_owe') ?? true;
    const count = await sendWeeklyTaxReminders(client, {
      onlyUserId: target?.id || null,
      onlyOwe,
      TAX_GIF_URL,
      PAYPAL_NAME,
    });
    return interaction.editReply(✅ Sent ${count} tax DM(s).);
  }
}

// Weekly reminders (call on ready + every 7 days)
export function initTaxScheduler(client, { TAX_GIF_URL, PAYPAL_NAME }) {
  setTimeout(() => sendWeeklyTaxReminders(client, { TAX_GIF_URL, PAYPAL }
                                          
}
