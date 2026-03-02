import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
} from "discord.js";

/* ================= CONFIG ================= */

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const PANEL_CHANNEL_ID = process.env.PANEL_CHANNEL_ID;
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID;
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID;

const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY;
const ROBLOX_GROUP_ID = 819348691;

const SEABANK_ACCOUNT = process.env.SEABANK_ACCOUNT;
const SEABANK_NAME = process.env.SEABANK_NAME;

const ELIGIBLE_DAYS = Number(process.env.ELIGIBLE_DAYS || 14);
const PRICE_PER_1000 = Number(process.env.PRICE_PER_1000 || 100000);

const PROOF_DEADLINE_MINUTES = 30;
const AUTO_CLOSE_MINUTES = 30;

if (!DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN");
if (!GUILD_ID) throw new Error("Missing GUILD_ID");
if (!PANEL_CHANNEL_ID) throw new Error("Missing PANEL_CHANNEL_ID");
if (!TICKET_CATEGORY_ID) throw new Error("Missing TICKET_CATEGORY_ID");
if (!STAFF_ROLE_ID) throw new Error("Missing STAFF_ROLE_ID");
if (!ROBLOX_API_KEY) throw new Error("Missing ROBLOX_API_KEY");

/* ================= STORAGE ================= */

const DATA_FILE = path.resolve("./orders.json");
const orders = new Map();

function loadOrders() {
  if (!fs.existsSync(DATA_FILE)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  for (const o of raw) orders.set(o.orderId, o);
}

function saveOrders() {
  fs.writeFileSync(DATA_FILE, JSON.stringify([...orders.values()], null, 2));
}

function nowIso() {
  return new Date().toISOString();
}

function addMinutes(dateIso, minutes) {
  return new Date(new Date(dateIso).getTime() + minutes * 60000).toISOString();
}

function fmtIDR(n) {
  return new Intl.NumberFormat("id-ID").format(n);
}

function fmtDateID(d) {
  return new Date(d).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
}

function daysBetween(a, b) {
  return Math.floor(Math.abs(new Date(a) - new Date(b)) / 86400000);
}

function isStaff(member) {
  return member?.roles?.cache?.has(STAFF_ROLE_ID);
}

function computeTotal(qty) {
  return (qty / 1000) * PRICE_PER_1000;
}

function newOrderId() {
  return "T-" + Math.floor(10000 + Math.random() * 90000);
}

/* ================= ROBLOX CHECK ================= */

async function robloxUsernameToUserId(username) {
  const r = await fetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usernames: [username] }),
  });
  const json = await r.json();
  return json?.data?.[0]?.id || null;
}

async function robloxGetMembership(userId) {
  const filter = encodeURIComponent(`user == 'users/${userId}'`);
  const r = await fetch(
    `https://apis.roblox.com/cloud/v2/groups/${ROBLOX_GROUP_ID}/memberships?filter=${filter}`,
    { headers: { "x-api-key": ROBLOX_API_KEY } }
  );
  const json = await r.json();
  return json?.groupMemberships?.[0] || null;
}

function extractJoinTime(m) {
  return m?.createTime || m?.joinedTime || null;
}

async function checkEligibility(username) {
  const userId = await robloxUsernameToUserId(username);
  if (!userId) return { ok: false, reason: "Username tidak ditemukan." };

  const membership = await robloxGetMembership(userId);
  if (!membership) return { ok: false, reason: "Belum join komunitas." };

  const join = extractJoinTime(membership);
  if (!join) return { ok: false, reason: "Tidak bisa membaca tanggal join." };

  const days = daysBetween(nowIso(), join);
  return {
    ok: days >= ELIGIBLE_DAYS,
    days,
    join,
    userId,
  };
}

/* ================= DISCORD ================= */

loadOrders();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

client.once("ready", async () => {
  console.log("Bot ready:", client.user.tag);

  setInterval(() => autoCloseSweep(), 60000);

  const guild = await client.guilds.fetch(GUILD_ID);
  const channel = await guild.channels.fetch(PANEL_CHANNEL_ID);

  const embed = new EmbedBuilder()
    .setTitle("💸 ORDER ROBUX")
    .setDescription("Klik tombol di bawah untuk order.");

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("open_order")
      .setLabel("💸 ORDER ROBUX")
      .setStyle(ButtonStyle.Success)
  );

  await channel.send({ embeds: [embed], components: [row] });
});

/* ================= AUTO CLOSE ================= */

async function autoCloseSweep() {
  const now = Date.now();

  for (const order of orders.values()) {
    if (order.status === "CLOSED") continue;

    const last = new Date(order.lastActivityAt || order.createdAt).getTime();

    if (order.awaitingProof && order.proofDeadlineAt) {
      if (now >= new Date(order.proofDeadlineAt).getTime()) {
        await closeTicket(order, "Deadline bukti habis.");
      }
      continue;
    }

    if (order.autoCloseArmed) {
      if (now - last >= AUTO_CLOSE_MINUTES * 60000) {
        await closeTicket(order, "Inactivity.");
      }
    }
  }
}

async function closeTicket(order, reason) {
  const guild = await client.guilds.fetch(order.guildId);
  const ch = await guild.channels.fetch(order.channelId);
  await ch.permissionOverwrites.edit(order.userId, { SendMessages: false });
  await ch.send("🔒 Ticket ditutup otomatis. " + reason);
  order.status = "CLOSED";
  saveOrders();
}

/* ================= MESSAGE TRACK ================= */

client.on("messageCreate", async (msg) => {
  if (!msg.guild || msg.author.bot) return;

  const order = [...orders.values()].find((o) => o.channelId === msg.channelId);
  if (!order) return;

  // hanya stop timer kalau kirim gambar
  const hasImage =
    msg.attachments.size > 0 &&
    [...msg.attachments.values()].some((a) =>
      a.contentType?.startsWith("image/")
    );

  if (hasImage && order.awaitingProof) {
    order.awaitingProof = false;
    order.proofDeadlineAt = null;
    order.status = "PROOF_SUBMITTED";
    await msg.channel.send("✅ Bukti diterima. Menunggu staff.");
  }

  order.lastActivityAt = nowIso();
  saveOrders();
});

/* ================= INTERACTIONS ================= */

client.on("interactionCreate", async (i) => {
  try {
    if (i.isButton() && i.customId === "open_order") {
      const modal = new ModalBuilder()
        .setCustomId("submit_order")
        .setTitle("Order Robux");

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("username")
            .setLabel("Username Roblox")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("qty")
            .setLabel("Jumlah Robux (kelipatan 1000)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        )
      );

      return i.showModal(modal);
    }

    if (i.isModalSubmit() && i.customId === "submit_order") {
      await i.deferReply({ ephemeral: true });

      const username = i.fields.getTextInputValue("username");
      const qty = Number(i.fields.getTextInputValue("qty"));

      const eligibility = await checkEligibility(username);

      const guild = await client.guilds.fetch(GUILD_ID);
      const ticket = await guild.channels.create({
        name: `ticket-${newOrderId()}`,
        type: ChannelType.GuildText,
        parent: TICKET_CATEGORY_ID,
        permissionOverwrites: [
          { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          {
            id: i.user.id,
            allow: [
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.SendMessages,
              PermissionsBitField.Flags.ReadMessageHistory,
              PermissionsBitField.Flags.AttachFiles,
            ],
          },
          {
            id: STAFF_ROLE_ID,
            allow: [
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.SendMessages,
              PermissionsBitField.Flags.ReadMessageHistory,
            ],
          },
        ],
      });

      const orderId = newOrderId();
      const total = computeTotal(qty);

      const order = {
        orderId,
        guildId: GUILD_ID,
        channelId: ticket.id,
        userId: i.user.id,
        createdAt: nowIso(),
        lastActivityAt: nowIso(),
        qty,
        total,
        awaitingProof: false,
        autoCloseArmed: false,
        status: "OPEN",
      };

      if (!eligibility.ok) {
        order.status = "INELIGIBLE";
        order.autoCloseArmed = true;

        await ticket.send(
          `❌ Kamu baru join komunitas ${eligibility.days || 0} hari.\n` +
            `Minimal ${ELIGIBLE_DAYS} hari.`
        );

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`close_${orderId}`)
            .setLabel("Close Ticket")
            .setStyle(ButtonStyle.Danger)
        );

        await ticket.send({ components: [row] });
        orders.set(orderId, order);
        saveOrders();
        return i.editReply(`Ticket dibuat: <#${ticket.id}>`);
      }

      // Eligible flow
      order.awaitingProof = true;
      order.proofDeadlineAt = addMinutes(nowIso(), PROOF_DEADLINE_MINUTES);

      const embed = new EmbedBuilder()
        .setTitle("Order Detail")
        .setDescription(
          `Status Join: ✅ ${eligibility.days} hari\n` +
            `Jumlah: ${qty}\n` +
            `Total: Rp ${fmtIDR(total)}`
        );

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`pay_${orderId}`)
          .setLabel("💳 Bank Transfer")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`cancel_${orderId}`)
          .setLabel("❌ Batalkan Order")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`done_${orderId}`)
          .setLabel("✅ Proses Selesai")
          .setStyle(ButtonStyle.Success)
      );

      await ticket.send({ embeds: [embed], components: [row] });
      orders.set(orderId, order);
      saveOrders();

      return i.editReply(`Ticket dibuat: <#${ticket.id}>`);
    }

    if (i.isButton()) {
      const [action, orderId] = i.customId.split("_");
      const order = orders.get(orderId);
      if (!order) return;

      if (action === "pay") {
        await i.reply({
          embeds: [
            new EmbedBuilder()
              .setTitle("Transfer SeaBank")
              .setDescription(
                `Rekening: ${SEABANK_ACCOUNT}\nA/N: ${SEABANK_NAME}\nTotal: Rp ${fmtIDR(
                  order.total
                )}`
              ),
          ],
        });
      }

      if (action === "cancel") {
        await closeTicket(order, "Order dibatalkan.");
      }

      if (action === "done") {
        const member = await i.guild.members.fetch(i.user.id);
        if (!isStaff(member))
          return i.reply({ content: "Khusus staff.", ephemeral: true });

        order.autoCloseArmed = true;
        order.awaitingProof = false;
        order.lastActivityAt = nowIso();

        const now = new Date();
        await i.channel.send(
          `🎉 Robux berhasil dikirim (${order.qty}) pada ${fmtDateID(
            now
          )}\nSilakan cek kembali.`
        );
      }

      if (action === "close") {
        await closeTicket(order, "Manual close.");
      }

      saveOrders();
    }
  } catch (err) {
    console.error(err);
  }
});

client.login(DISCORD_TOKEN);