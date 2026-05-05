const db = require("../../db");

function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
}

function parseMeta(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try { return JSON.parse(String(value)); } catch (_) { return {}; }
}

function normalizeReservation(row) {
  const meta = parseMeta(row.meta);
  const customer = meta.customer || {};
  const service = meta.service || {};

  return {
    id: row.id,
    date: row.date_start,
    slot: row.slot,
    type: row.type,
    status: row.status,
    paid_at: row.paid_at,
    label: row.formation || meta.formation || service.name || "RKbeauty",
    amount_paid_eur: row.amount != null ? Number(row.amount) / 100 : null,
    currency: row.currency || "eur",
    customer: {
      name: customer.name || [customer.prenom, customer.nom].filter(Boolean).join(" "),
      email: customer.email || "",
      phone: customer.phone || customer.tel || "",
    },
    details: {
      date_start: meta.date_start || row.date_start,
      date_end: meta.date_end || row.date_end || row.date_start,
      days_count: meta.days_count || 1,
      duration: service.duration || "",
      total_eur: service.totalEUR || meta.totalPriceEUR || null,
      balance_eur: row.type === "service" && service.totalEUR != null && row.amount != null
        ? Math.max(0, Number(service.totalEUR) - Number(row.amount) / 100)
        : null,
    },
  };
}

async function listAdminReservations(req, res) {
  const type = String(req.query.type || "").trim();
  const status = String(req.query.status || "paid").trim();
  const dateFrom = String(req.query.date_from || "").trim();
  const dateTo = String(req.query.date_to || "").trim();
  const limit = Math.min(Number(req.query.limit || 80), 200);

  const where = [];
  const params = [];

  if (["service", "formation"].includes(type)) {
    where.push("type=?");
    params.push(type);
  }
  if (["pending", "paid", "cancelled"].includes(status)) {
    where.push("status=?");
    params.push(status);
  }
  if (dateFrom) {
    where.push("date_start >= ?");
    params.push(dateFrom);
  }
  if (dateTo) {
    where.push("date_start <= ?");
    params.push(dateTo);
  }

  const sqlWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";

  try {
    const [rows] = await db.query(
      `SELECT id, date_start, date_end, slot, type, meta, status, paid_at, formation, amount, currency, stripe_session_id, formation_session_id
       FROM reservations
       ${sqlWhere}
       ORDER BY date_start DESC, id DESC
       LIMIT ?`,
      [...params, limit]
    );
    return res.json(rows.map(normalizeReservation));
  } catch (e) {
    console.error("listAdminReservations:", e);
    return res.status(500).json({ message: "Erreur liste réservations" });
  }
}

async function dashboardStats(req, res) {
  try {
    const [[todayReservations]] = await db.query(
      "SELECT COUNT(*) AS total FROM reservations WHERE date_start <= CURDATE() AND date_end >= CURDATE() AND status='paid'"
    );
    const [[monthRevenue]] = await db.query(
      `SELECT COALESCE(SUM(amount),0) AS cents
       FROM reservations
       WHERE status='paid' AND paid_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`
    );
    const [[formationsPublished]] = await db.query("SELECT COUNT(*) AS total FROM formations WHERE status='published'");
    const [[servicesPublished]] = await db.query("SELECT COUNT(*) AS total FROM services WHERE status='published'");
    const [[sessionsOpen]] = await db.query(
      "SELECT COUNT(*) AS total FROM formation_sessions WHERE status='published' AND start_date >= CURDATE()"
    );
    const [upcomingRows] = await db.query(
      `SELECT id, date_start, date_end, slot, type, meta, status, formation, amount, currency
       FROM reservations
       WHERE status='paid' AND date_start >= CURDATE()
       ORDER BY date_start ASC, id ASC
       LIMIT 8`
    );

    return res.json({
      today_reservations: Number(todayReservations.total || 0),
      month_revenue_eur: Number(monthRevenue.cents || 0) / 100,
      formations_published: Number(formationsPublished.total || 0),
      services_published: Number(servicesPublished.total || 0),
      sessions_open: Number(sessionsOpen.total || 0),
      upcoming: upcomingRows.map(normalizeReservation),
    });
  } catch (e) {
    console.error("dashboardStats:", e);
    return res.status(500).json({ message: "Erreur dashboard admin" });
  }
}

async function lookupReservations(req, res) {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return res.status(400).json({ message: "Email valide requis" });
  }

  try {
    // On groupe par stripe_session_id pour éviter d'afficher une carte
    // par jour pour les formations multi-jours.
    // Une ligne par réservation — pas besoin de grouper
    const [rows] = await db.query(
      `SELECT id, date_start, date_end, slot, type, meta, status, paid_at, formation, amount, currency, stripe_session_id, formation_session_id
       FROM reservations
       WHERE status='paid'
         AND LOWER(JSON_UNQUOTE(JSON_EXTRACT(meta, '$.customer.email'))) = ?
       ORDER BY date_start DESC
       LIMIT 40`,
      [email]
    );
    return res.json(rows.map(normalizeReservation));
  } catch (e) {
    console.error("lookupReservations:", e);
    return res.status(500).json({ message: "Erreur recherche réservations" });
  }
}

module.exports = {
  requireAdmin,
  listAdminReservations,
  dashboardStats,
  lookupReservations,
};