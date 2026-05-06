const Stripe = require("stripe");
const db = require("../../db");
const nodemailer = require("nodemailer");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

function eurosToCents(eur) {
  const n = Number(String(eur).replace(",", ".").replace("€", "").trim());
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function toSQLDate(d) {
  if (!d) return null;
  if (typeof d === "string") return d.slice(0, 10);
  const dt = new Date(d);
  if (!Number.isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

function makeGroupId() {
  return "GRP-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

function getFrontUrl() {
  return process.env.FRONT_URL || process.env.FRONT_BASE_URL || "http://localhost:5500";
}


function parseJsonValue(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch (_) {
    return {};
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatEUR(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)} EUR` : "—";
}

function formatDateFr(value) {
  const d = toSQLDate(value);
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y}`;
}


function normalizeSlot(slot) {
  const value = String(slot || "").trim();
  if (!["morning", "afternoon", "early_morning"].includes(value)) return null;
  return value;
}

async function getSessionDates(conn, formationSessionId) {
  const [rows] = await conn.query(
    "SELECT session_date FROM formation_session_dates WHERE session_id=? ORDER BY session_date ASC",
    [formationSessionId]
  );
  return rows.map((r) => toSQLDate(r.session_date)).filter(Boolean);
}

async function loadBaseQuota(conn, type, slot) {
  try {
    const [[row]] = await conn.query(
      "SELECT max_places FROM quotas WHERE type=? AND slot=? LIMIT 1",
      [type, slot]
    );
    if (row) return Number(row.max_places);
  } catch (_) {
    // Compatibilité avec l'ancienne table quotas(slot, max_places)
    const [[row]] = await conn.query(
      "SELECT max_places FROM quotas WHERE slot=? LIMIT 1",
      [slot]
    );
    if (row) return Number(row.max_places);
  }

  if (type === "service") return 8;
  return 8;
}

async function assertSlotAvailable(conn, { date, slot, type }) {
  await conn.query("DELETE FROM reservation_holds WHERE expires_at <= NOW()");

  const baseQuota = await loadBaseQuota(conn, type, slot);

  const [[override]] = await conn.query(
    "SELECT `open`, quota FROM schedule_overrides WHERE date=? AND type=? AND slot=? FOR UPDATE",
    [date, type, slot]
  );

  let open = true;
  let quota = baseQuota;

  if (override) {
    open = !!override.open;
    if (override.quota != null) quota = Number(override.quota);
  }

  if (!open || quota <= 0) {
    const err = new Error("Créneau fermé par l'administration");
    err.status = 400;
    throw err;
  }

  const [[paidRow]] = await conn.query(
    "SELECT COUNT(*) AS total FROM reservations WHERE date_start <= ? AND date_end >= ? AND slot=? AND type=? AND status='paid' FOR UPDATE",
    [date, date, slot, type]
  );

  const [[holdsRow]] = await conn.query(
    "SELECT COUNT(*) AS total FROM reservation_holds WHERE date_start <= ? AND date_end >= ? AND slot=? AND type=? AND expires_at > NOW() FOR UPDATE",
    [date, date, slot, type]
  );

  if (Number(paidRow.total) + Number(holdsRow.total) >= Number(quota)) {
    const err = new Error("Créneau complet");
    err.status = 400;
    throw err;
  }
}

async function assertSlotAvailableRange(conn, dates, slot, type) {
  for (const date of dates) {
    await assertSlotAvailable(conn, { date, slot, type });
  }
}

async function assertSessionAvailable(conn, formationSessionId, seatsNeeded = 1) {
  await conn.query("DELETE FROM reservation_holds WHERE expires_at <= NOW()");

  const [[session]] = await conn.query(
    "SELECT id, capacity, status FROM formation_sessions WHERE id=? FOR UPDATE",
    [formationSessionId]
  );

  if (!session || session.status !== "published") {
    const err = new Error("Session de formation introuvable ou non publiée");
    err.status = 400;
    throw err;
  }

  // Compter les élèves distincts (stripe_session_id), pas les lignes.
  // Une formation multi-jours insère une ligne par jour — COUNT(*) serait faux.
  const [[paidRow]] = await conn.query(
    `SELECT COUNT(DISTINCT stripe_session_id) AS total
     FROM reservations
     WHERE formation_session_id=? AND type='formation' AND status='paid' FOR UPDATE`,
    [formationSessionId]
  );

  // Idem pour les holds : compter les groupes distincts
  const [[holdsRow]] = await conn.query(
    `SELECT COUNT(DISTINCT group_id) AS total
     FROM reservation_holds
     WHERE formation_session_id=? AND type='formation' AND expires_at > NOW() FOR UPDATE`,
    [formationSessionId]
  );

  const remaining = Number(session.capacity) - Number(paidRow.total) - Number(holdsRow.total);

  if (remaining < seatsNeeded) {
    const err = new Error("Session complète");
    err.status = 400;
    throw err;
  }
}

function getSmtpTransport() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) return null;

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

async function sendPaymentConfirmationEmail(summary) {
  const transporter = getSmtpTransport();
  if (!transporter || !summary?.to) return;

  const from = process.env.SMTP_FROM || "RKbeauty <no-reply@rkbeauty.fr>";
  const subject = "Confirmation de votre réservation — RKbeauty";
  const slotLabel = summary.slot === "early_morning" ? "Matin — 8h30 à 11h30"
    : summary.slot === "morning" ? "Matin — 11h30 à 14h30"
    : "Après-midi — 15h30 à 18h30";
  const typeLabel = summary.type === "service" ? "Prestation" : "Formation";
  const period =
    summary.dateStart && summary.dateEnd && summary.dateStart !== summary.dateEnd
      ? `${formatDateFr(summary.dateStart)} au ${formatDateFr(summary.dateEnd)}`
      : formatDateFr(summary.dateStart);

  const total = summary.totalEUR ? formatEUR(summary.totalEUR) : formatEUR(summary.amountEUR);
  const paid = formatEUR(summary.amountEUR || summary.depositEUR);
  const balance = summary.balanceEUR != null ? formatEUR(summary.balanceEUR) : null;

  const text = `Bonjour ${summary.name || ""},

Votre paiement a bien été confirmé ✅

Récapitulatif de votre réservation :
Type : ${typeLabel}
Réservation : ${summary.label || "RKbeauty"}
Date / période : ${period}
Créneau : ${slotLabel}
${summary.duration ? `Durée : ${summary.duration}\n` : ""}Montant payé : ${paid}
${balance ? `Reste à régler le jour J : ${balance}\n` : ""}

Lieu : ${process.env.FORMATION_ADDRESS || "22, rue de la révolution, Montreuil, 93100"}

Vous recevrez toute information complémentaire si nécessaire.
Merci pour votre confiance.

RKbeauty`;

  const html = `
  <div style="margin:0;padding:0;background:#f8f3ea;font-family:Arial,sans-serif;color:#171717;">
    <div style="max-width:680px;margin:0 auto;padding:28px 14px;">
      <div style="background:#111;padding:26px 24px;border-radius:18px 18px 0 0;text-align:center;border-bottom:3px solid #c9a961;">
        <div style="font-size:13px;letter-spacing:3px;color:#c9a961;text-transform:uppercase;">RKbeauty</div>
        <h1 style="margin:10px 0 0;color:#fff;font-family:Georgia,serif;font-weight:400;">Réservation confirmée</h1>
      </div>
      <div style="background:#fff;padding:26px 24px;border:1px solid #eadfca;border-top:0;border-radius:0 0 18px 18px;">
        <p style="font-size:16px;line-height:1.6;margin:0 0 14px;">Bonjour ${escapeHtml(summary.name || "")},</p>
        <p style="font-size:15px;line-height:1.6;margin:0 0 18px;">Votre paiement a bien été confirmé. Voici le récapitulatif de votre réservation :</p>
        <table style="border-collapse:collapse;width:100%;font-size:14px;">
          <tr><td style="padding:10px 0;border-bottom:1px solid #eee;color:#777;">Type</td><td style="padding:10px 0;border-bottom:1px solid #eee;font-weight:bold;text-align:right;">${escapeHtml(typeLabel)}</td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid #eee;color:#777;">Réservation</td><td style="padding:10px 0;border-bottom:1px solid #eee;font-weight:bold;text-align:right;">${escapeHtml(summary.label || "RKbeauty")}</td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid #eee;color:#777;">Date / période</td><td style="padding:10px 0;border-bottom:1px solid #eee;font-weight:bold;text-align:right;">${escapeHtml(period)}</td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid #eee;color:#777;">Créneau</td><td style="padding:10px 0;border-bottom:1px solid #eee;font-weight:bold;text-align:right;">${escapeHtml(slotLabel)}</td></tr>
          ${summary.duration ? `<tr><td style="padding:10px 0;border-bottom:1px solid #eee;color:#777;">Durée</td><td style="padding:10px 0;border-bottom:1px solid #eee;font-weight:bold;text-align:right;">${escapeHtml(summary.duration)}</td></tr>` : ""}
          <tr><td style="padding:10px 0;border-bottom:1px solid #eee;color:#777;">Lieu</td><td style="padding:10px 0;border-bottom:1px solid #eee;font-weight:bold;text-align:right;">${escapeHtml(process.env.FORMATION_ADDRESS || "22, rue de la révolution, Montreuil, 93100")}</td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid #eee;color:#777;">Montant payé</td><td style="padding:10px 0;border-bottom:1px solid #eee;font-weight:bold;text-align:right;color:#c9a961;">${escapeHtml(paid)}</td></tr>
          ${balance ? `<tr><td style="padding:10px 0;border-bottom:1px solid #eee;color:#777;">Reste à régler</td><td style="padding:10px 0;border-bottom:1px solid #eee;font-weight:bold;text-align:right;">${escapeHtml(balance)}</td></tr>` : ""}
        </table>
        <div style="margin-top:22px;padding:14px 16px;background:#fbf7ef;border-left:4px solid #c9a961;font-size:13px;line-height:1.6;color:#555;">
          Les données bancaires sont traitées par Stripe et ne sont pas stockées par RKbeauty.
        </div>
        <p style="font-size:15px;line-height:1.6;margin:22px 0 0;">Merci pour votre confiance,<br><strong>RKbeauty</strong></p>
      </div>
    </div>
  </div>`;

  await transporter.sendMail({ from, to: summary.to, subject, text, html });
}

async function sendAdminNotificationEmail(summary) {
  const transporter = getSmtpTransport();
  const adminTo = process.env.ADMIN_EMAIL || process.env.SMTP_USER;
  if (!transporter || !adminTo) return;

  const from = process.env.SMTP_FROM || "RKbeauty <no-reply@rkbeauty.fr>";
  const slotLabel = summary.slot === "early_morning" ? "Matin 8h30"
    : summary.slot === "morning" ? "Matin 11h30"
    : "Après-midi";
  const typeLabel = summary.type === "service" ? "Prestation" : "Formation";
  const period = summary.dateStart && summary.dateEnd && summary.dateStart !== summary.dateEnd
    ? `${formatDateFr(summary.dateStart)} au ${formatDateFr(summary.dateEnd)}`
    : formatDateFr(summary.dateStart);

  const subject = `Nouvelle réservation payée — ${typeLabel}`;
  const text = `Nouvelle réservation payée RKbeauty

Type : ${typeLabel}
Réservation : ${summary.label || "RKbeauty"}
Client : ${summary.name || "—"}
Email : ${summary.to || "—"}
Téléphone : ${summary.phone || "—"}
Date / période : ${period}
Créneau : ${slotLabel}
Montant payé : ${formatEUR(summary.amountEUR || summary.depositEUR)}
${summary.balanceEUR != null ? `Reste à régler : ${formatEUR(summary.balanceEUR)}\n` : ""}`;

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.55;color:#111">
      <h2>Nouvelle réservation payée ✅</h2>
      <table style="border-collapse:collapse;width:100%;max-width:680px">
        <tr><td style="padding:8px;border-bottom:1px solid #eee"><b>Type</b></td><td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(typeLabel)}</td></tr>
        <tr><td style="padding:8px;border-bottom:1px solid #eee"><b>Réservation</b></td><td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(summary.label || "RKbeauty")}</td></tr>
        <tr><td style="padding:8px;border-bottom:1px solid #eee"><b>Client</b></td><td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(summary.name || "—")}</td></tr>
        <tr><td style="padding:8px;border-bottom:1px solid #eee"><b>Email</b></td><td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(summary.to || "—")}</td></tr>
        <tr><td style="padding:8px;border-bottom:1px solid #eee"><b>Téléphone</b></td><td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(summary.phone || "—")}</td></tr>
        <tr><td style="padding:8px;border-bottom:1px solid #eee"><b>Date / période</b></td><td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(period)}</td></tr>
        <tr><td style="padding:8px;border-bottom:1px solid #eee"><b>Créneau</b></td><td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(slotLabel)}</td></tr>
        <tr><td style="padding:8px;border-bottom:1px solid #eee"><b>Montant payé</b></td><td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(formatEUR(summary.amountEUR || summary.depositEUR))}</td></tr>
        ${summary.balanceEUR != null ? `<tr><td style="padding:8px;border-bottom:1px solid #eee"><b>Reste à régler</b></td><td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(formatEUR(summary.balanceEUR))}</td></tr>` : ""}
      </table>
    </div>`;

  await transporter.sendMail({ from, to: adminTo, subject, text, html });
}

async function finalizeGroup(session) {
  const groupId = session?.metadata?.group_id;
  if (!groupId) return null;

  const [already] = await db.query(
    "SELECT id FROM reservations WHERE stripe_session_id=? LIMIT 1",
    [session.id]
  );
  if (already.length) return null;

  const [holds] = await db.query(
    "SELECT * FROM reservation_holds WHERE group_id=? AND stripe_session_id=? ORDER BY date_start ASC, id ASC",
    [groupId, session.id]
  );
  if (!holds.length) return null;

  const metaObj = parseJsonValue(holds[0]?.meta);

  for (const hold of holds) {
    const metaValue = typeof hold.meta === "string" ? hold.meta : JSON.stringify(hold.meta || {});
    const reservationType = hold.type === "service" ? "service" : "formation";

    await db.query(
      `INSERT INTO reservations
       (date_start, date_end, slot, type, meta, status, paid_at, formation, amount, currency, stripe_session_id, stripe_payment_intent_id, formation_session_id)
       VALUES (?, ?, ?, ?, ?, 'paid', NOW(), ?, ?, ?, ?, ?, ?)`,
      [
        hold.date_start,
        hold.date_end,
        hold.slot,
        reservationType,
        metaValue,
        hold.formation,
        hold.amount,
        hold.currency || "eur",
        session.id,
        session.payment_intent || null,
        hold.formation_session_id || null,
      ]
    );
  }

  await db.query("DELETE FROM reservation_holds WHERE group_id=?", [groupId]);

  const customer = metaObj.customer || {};

  const amountPaidEUR = session.amount_total ? Number(session.amount_total) / 100 : Number(metaObj.totalPriceEUR || metaObj.service?.depositEUR || 0);
  const totalEUR = metaObj.type === "service" && metaObj.service?.totalEUR
    ? Number(metaObj.service.totalEUR)
    : Number(metaObj.totalPriceEUR || amountPaidEUR);
  const balanceEUR = metaObj.type === "service" ? Math.max(0, totalEUR - amountPaidEUR) : null;

  return {
    type: holds[0].type === "service" ? "service" : "formation",
    to: customer.email || session.customer_email || session.customer_details?.email,
    name: customer.name || [customer.prenom, customer.nom].filter(Boolean).join(" ") || session.customer_details?.name || "",
    phone: customer.phone || customer.tel || "",
    label: metaObj.formation || metaObj.service?.name || session.metadata?.formation || holds[0]?.formation || "RKbeauty",
    amountEUR: amountPaidEUR,
    totalEUR,
    depositEUR: amountPaidEUR,
    balanceEUR,
    duration: metaObj.service?.duration || (metaObj.days_count ? `${metaObj.days_count} jour(s)` : ""),
    daysCount: metaObj.days_count || holds.length,
    currency: session.currency || "eur",
    slot: metaObj.slot || session.metadata?.slot || holds[0]?.slot,
    dateStart: metaObj.date_start || session.metadata?.date_start || toSQLDate(holds[0]?.date_start),
    dateEnd: metaObj.date_end || session.metadata?.date_end || toSQLDate(holds[0]?.date_end),
  };
}

async function createCheckoutSession(req, res) {
  const { formation_session_id, slot, customer, formation, totalPriceEUR, message } = req.body || {};

  const formationSessionId = Number(formation_session_id);
  const cleanSlot = normalizeSlot(slot);

  if (!Number.isFinite(formationSessionId)) {
    return res.status(400).json({ message: "formation_session_id requis" });
  }
  if (!cleanSlot) return res.status(400).json({ message: "slot invalide" });
  if (!customer?.name || !customer?.email || !customer?.phone) {
    return res.status(400).json({ message: "Infos client incomplètes" });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const dates = await getSessionDates(conn, formationSessionId);
    if (!dates.length) {
      const err = new Error("La session de cette formation n’est pas encore disponible.");
      err.status = 400;
      throw err;
    }

    const [[sessionInfo]] = await conn.query(
      "SELECT formation_label, price_eur FROM formation_sessions WHERE id=? AND status='published' FOR UPDATE",
      [formationSessionId]
    );
    if (!sessionInfo) {
      const err = new Error("Session de formation non publiée ou introuvable");
      err.status = 400;
      throw err;
    }

    const dbFormationLabel = sessionInfo.formation_label || formation || "Formation RKbeauty";
    const dbPriceEUR = Number(sessionInfo.price_eur);
    const amount = eurosToCents(dbPriceEUR);
    if (!amount || amount < 100) {
      const err = new Error("Montant invalide");
      err.status = 400;
      throw err;
    }

    // Pour les formations : on vérifie uniquement la capacité de la session.
    // assertSlotAvailableRange est retiré — il comptait une place par jour
    // au lieu d'une place par élève, vidant le quota pour toute la durée.
    await assertSessionAvailable(conn, formationSessionId, 1);

    const groupId = makeGroupId();
    const meta = {
      type: "formation",
      formation_session_id: formationSessionId,
      customer,
      formation: dbFormationLabel,
      totalPriceEUR: dbPriceEUR,
      message: message || "",
      slot: cleanSlot,
      date_start: dates[0],
      date_end: dates[dates.length - 1],
      days_count: dates.length,
    };

    // Un seul hold par réservation
    await conn.query(
      `INSERT INTO reservation_holds
       (group_id, formation_session_id, date_start, date_end, slot, type, formation, amount, currency, expires_at, meta)
       VALUES (?, ?, ?, ?, ?, 'formation', ?, ?, 'eur', DATE_ADD(NOW(), INTERVAL 15 MINUTE), ?)`,
      [groupId, formationSessionId, dates[0], dates[dates.length - 1], cleanSlot, dbFormationLabel, amount, JSON.stringify(meta)]
    );

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: customer.email,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "eur",
            unit_amount: amount,
            product_data: { name: dbFormationLabel },
          },
        },
      ],
      success_url: `${getFrontUrl()}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${getFrontUrl()}/cancel.html?group_id=${groupId}`,
      metadata: {
        group_id: groupId,
        type: "formation",
        formation_session_id: String(formationSessionId),
        slot: cleanSlot,
        formation: dbFormationLabel,
        date_start: dates[0] || "",
        date_end: dates[dates.length - 1] || "",
        days_count: String(dates.length),
      },
    });

    await conn.query("UPDATE reservation_holds SET stripe_session_id=? WHERE group_id=?", [
      checkoutSession.id,
      groupId,
    ]);

    await conn.commit();
    return res.json({ url: checkoutSession.url });
  } catch (e) {
    await conn.rollback();
    console.error("createCheckoutSession error:", e);
    return res.status(e.status || 500).json({ message: e.message || "Erreur paiement formation" });
  } finally {
    conn.release();
  }
}

async function createServiceCheckoutSession(req, res) {
  const { slotDate, slotTime, customer, service } = req.body || {};
  const cleanDate = toSQLDate(slotDate);
  const cleanSlot = normalizeSlot(slotTime);

  if (!cleanDate) return res.status(400).json({ message: "date manquante" });
  if (!cleanSlot) return res.status(400).json({ message: "créneau invalide" });
  if (!customer?.nom || !customer?.prenom || !customer?.email) {
    return res.status(400).json({ message: "informations client incomplètes" });
  }
  const serviceCode = String(service?.code || "").trim();
  if (!serviceCode && !service?.name) {
    return res.status(400).json({ message: "service requis" });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Le prix vient de la base de données, pas du navigateur.
    const params = serviceCode ? [serviceCode] : [service.name];
    const query = serviceCode
      ? "SELECT code, name, price_eur, deposit_percent, duration_label FROM services WHERE code=? AND status='published' FOR UPDATE"
      : "SELECT code, name, price_eur, deposit_percent, duration_label FROM services WHERE name=? AND status='published' FOR UPDATE";
    const [[catalogService]] = await conn.query(query, params);
    if (!catalogService) {
      const err = new Error("Prestation indisponible ou non publiée");
      err.status = 400;
      throw err;
    }

    const serviceName = catalogService.name;
    const totalEUR = Number(catalogService.price_eur);
    const depositPct = Number(catalogService.deposit_percent ?? 50) / 100;
    const depositEUR = Math.round(totalEUR * depositPct * 100) / 100;
    const serviceDuration = catalogService.duration_label || service?.duration || "";

    const amount = eurosToCents(depositEUR);
    if (!amount || amount < 100) {
      const err = new Error("montant invalide");
      err.status = 400;
      throw err;
    }

    await assertSlotAvailable(conn, { date: cleanDate, slot: cleanSlot, type: "service" });

    const groupId = makeGroupId();
    const customerName = `${customer.prenom} ${customer.nom}`.trim();

    const meta = {
      type: "service",
      customer: {
        name: customerName,
        nom: customer.nom,
        prenom: customer.prenom,
        email: customer.email,
        phone: customer.phone || customer.tel || "",
      },
      service: {
        name: serviceName,
        totalEUR,
        depositEUR,
        duration: serviceDuration,
      },
      formation: serviceName,
      totalPriceEUR: depositEUR,
      slot: cleanSlot,
      date_start: cleanDate,
      date_end: cleanDate,
      days_count: 1,
    };

    await conn.query(
      `INSERT INTO reservation_holds
       (group_id, formation_session_id, date_start, date_end, slot, type, formation, amount, currency, expires_at, meta)
       VALUES (?, NULL, ?, ?, ?, 'service', ?, ?, 'eur', DATE_ADD(NOW(), INTERVAL 15 MINUTE), ?)`,
      [groupId, cleanDate, cleanDate, cleanSlot, serviceName, amount, JSON.stringify(meta)]
    );

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: customer.email,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "eur",
            unit_amount: amount,
            product_data: { name: `Acompte 50% — ${serviceName}` },
          },
        },
      ],
      success_url: `${getFrontUrl()}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${getFrontUrl()}/cancel.html?group_id=${groupId}`,
      metadata: {
        group_id: groupId,
        type: "service",
        slot: cleanSlot,
        formation: serviceName,
        date_start: cleanDate,
        date_end: cleanDate,
        days_count: "1",
      },
    });

    await conn.query("UPDATE reservation_holds SET stripe_session_id=? WHERE group_id=?", [
      checkoutSession.id,
      groupId,
    ]);

    await conn.commit();
    return res.json({ url: checkoutSession.url });
  } catch (e) {
    await conn.rollback();
    console.error("createServiceCheckoutSession error:", e);
    return res.status(e.status || 500).json({ message: e.message || "Erreur paiement service" });
  } finally {
    conn.release();
  }
}

async function stripeWebhook(req, res) {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) {
      const session = event.data.object;
      const summary = await finalizeGroup(session);
      if (summary?.to) {
        try {
          await sendPaymentConfirmationEmail(summary);
        } catch (mailErr) {
          console.error("Email confirmation error:", mailErr?.message || mailErr);
        }
      }
      try {
        await sendAdminNotificationEmail(summary);
      } catch (mailErr) {
        console.error("Email admin notification error:", mailErr?.message || mailErr);
      }
    }

    if (event.type === "checkout.session.async_payment_failed") {
      const session = event.data.object;
      const groupId = session.metadata?.group_id;
      if (groupId) await db.query("DELETE FROM reservation_holds WHERE group_id=?", [groupId]);
    }

    return res.json({ received: true });
  } catch (e) {
    console.error("Webhook handling error:", e);
    return res.status(500).json({ message: "Erreur webhook" });
  }
}

async function cancelGroup(req, res) {
  try {
    const groupId = req.params.groupId;
    if (!groupId) return res.status(400).json({ message: "group_id requis" });
    await db.query("DELETE FROM reservation_holds WHERE group_id=?", [groupId]);
    return res.json({ ok: true });
  } catch (e) {
    console.error("cancelGroup error:", e);
    return res.status(500).json({ message: "Erreur annulation" });
  }
}

async function getCheckoutSessionStatus(req, res) {
  try {
    const sessionId = req.params.sessionId;
    const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId);

    const [[reservation]] = await db.query(
      `SELECT id, date_start, date_end, slot, type, meta, status, formation, amount, currency, stripe_session_id, formation_session_id
       FROM reservations
       WHERE stripe_session_id=?
       LIMIT 1`,
      [sessionId]
    );

    return res.json({
      id: checkoutSession.id,
      payment_status: checkoutSession.payment_status,
      amount_total: checkoutSession.amount_total,
      currency: checkoutSession.currency,
      customer_details: checkoutSession.customer_details,
      status: checkoutSession.status,
      metadata: checkoutSession.metadata,
      reservation: reservation || null,
    });
  } catch (e) {
    console.error("getCheckoutSessionStatus error:", e);
    return res.status(500).json({ message: "Impossible de récupérer la session Stripe" });
  }
}

module.exports = {
  createCheckoutSession,
  createServiceCheckoutSession,
  stripeWebhook,
  getCheckoutSessionStatus,
  cancelGroup,
};