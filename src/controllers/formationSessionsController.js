// back/src/controllers/formationSessionsController.js
const db = require("../../db");

// ─── Auth admin ───────────────────────────────────────────
function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
}

// ─── Utilitaire : regénère les dates d'une session ────────
async function regenerateSessionDates(conn, sessionId, startDate, daysCount) {
  await conn.query("DELETE FROM formation_session_dates WHERE session_id=?", [sessionId]);
  const values = [];
  for (let i = 0; i < daysCount; i++) {
    values.push([
      sessionId,
      new Date(new Date(startDate).getTime() + i * 86400000).toISOString().slice(0, 10),
    ]);
  }
  await conn.query(
    "INSERT INTO formation_session_dates(session_id, session_date) VALUES ?",
    [values]
  );
}

// ═══════════════════════════════════════════════════════════
//  ROUTES PUBLIQUES
// ═══════════════════════════════════════════════════════════

/**
 * GET /formations
 * ───────────────────────────────────────────────────────────
 * Retourne la liste de TOUTES les formations publiées,
 * dédoublonnées par formation_code (1 ligne par code).
 * Utilisé par index.html et formations.html pour afficher
 * les formations sans token admin.
 *
 * Réponse : tableau de { formation_code, formation_label,
 *   price_eur, days_count, slot_policy, capacity, remaining,
 *   start_date, note }
 */
async function listPublicFormations(req, res) {
  try {
    const [rows] = await db.query(`
      SELECT
        fs.formation_code,
        fs.formation_label,
        fs.price_eur,
        fs.days_count,
        fs.slot_policy,
        fs.capacity,
        fs.note,
        MIN(fs.start_date) AS start_date,
        SUM(GREATEST(fs.capacity - COALESCE(r.reserved,0) - COALESCE(h.holds,0), 0)) AS remaining

      FROM formation_sessions fs

      LEFT JOIN (
        SELECT formation_session_id, COUNT(*) AS reserved
        FROM reservations
        WHERE formation_session_id IS NOT NULL
          AND status = 'paid'
        GROUP BY formation_session_id
      ) r ON r.formation_session_id = fs.id

      LEFT JOIN (
        SELECT formation_session_id, COUNT(*) AS holds
        FROM reservation_holds
        WHERE formation_session_id IS NOT NULL
          AND expires_at > NOW()
        GROUP BY formation_session_id
      ) h ON h.formation_session_id = fs.id

      WHERE fs.status = 'published'

      GROUP BY
        fs.formation_code,
        fs.formation_label,
        fs.price_eur,
        fs.days_count,
        fs.slot_policy,
        fs.capacity,
        fs.note

      ORDER BY fs.price_eur ASC
    `);

    return res.json(rows);
  } catch (e) {
    console.error("listPublicFormations:", e);
    return res.status(500).json({ message: "Erreur formations (public)" });
  }
}

/**
 * GET /formation-sessions?formation_code=F2J-150
 * Sessions disponibles pour un code de formation donné.
 */
async function listPublicSessions(req, res) {
  const formation_code = (req.query.formation_code || "").trim();
  if (!formation_code) return res.status(400).json({ message: "formation_code requis" });

  try {
    const [rows] = await db.query(
      `
      SELECT
        fs.id,
        fs.formation_code,
        fs.formation_label,
        fs.price_eur,
        fs.days_count,
        fs.start_date,
        fs.slot_policy,
        fs.status,
        fs.note,
        fs.capacity,
        COALESCE(r.reserved, 0) AS reserved,
        COALESCE(h.holds, 0) AS holds,
        GREATEST(fs.capacity - COALESCE(r.reserved,0) - COALESCE(h.holds,0), 0) AS remaining

      FROM formation_sessions fs

      LEFT JOIN (
        SELECT formation_session_id, COUNT(*) AS reserved
        FROM reservations
        WHERE formation_session_id IS NOT NULL AND status='paid'
        GROUP BY formation_session_id
      ) r ON r.formation_session_id = fs.id

      LEFT JOIN (
        SELECT formation_session_id, COUNT(*) AS holds
        FROM reservation_holds
        WHERE formation_session_id IS NOT NULL AND expires_at > NOW()
        GROUP BY formation_session_id
      ) h ON h.formation_session_id = fs.id

      WHERE fs.status = 'published'
        AND fs.start_date >= CURDATE()
        AND fs.formation_code = ?

      ORDER BY fs.start_date ASC
      `,
      [formation_code]
    );

    return res.json(rows.filter((s) => Number(s.remaining) > 0));
  } catch (e) {
    console.error("listPublicSessions:", e);
    return res.status(500).json({ message: "Erreur sessions (public)" });
  }
}

/**
 * GET /formation-sessions/:id
 * Détails d'une session + ses dates.
 */
async function getPublicSessionById(req, res) {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ message: "id invalide" });

  try {
    const [[session]] = await db.query(
      `SELECT id, formation_code, formation_label, price_eur, days_count,
              start_date, slot_policy, status, note, capacity
       FROM formation_sessions
       WHERE id=? AND status='published'`,
      [id]
    );

    if (!session) return res.status(404).json({ message: "Session introuvable" });

    const [dates] = await db.query(
      "SELECT session_date FROM formation_session_dates WHERE session_id=? ORDER BY session_date ASC",
      [id]
    );

    return res.json({ ...session, dates: dates.map((d) => d.session_date) });
  } catch (e) {
    console.error("getPublicSessionById:", e);
    return res.status(500).json({ message: "Erreur session (public)" });
  }
}

// ═══════════════════════════════════════════════════════════
//  ROUTES ADMIN
// ═══════════════════════════════════════════════════════════

async function listAdminSessions(req, res) {
  const status = (req.query.status || "").trim();
  const formation_code = (req.query.formation_code || "").trim();
  const allowedStatus = new Set(["draft", "published", "closed"]);

  try {
    const params = [];
    const where = [];

    if (status && allowedStatus.has(status)) {
      where.push("status=?");
      params.push(status);
    }
    if (formation_code) {
      where.push("formation_code=?");
      params.push(formation_code);
    }

    const sqlWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await db.query(
      `
      SELECT
        fs.*,
        COALESCE(r.reserved, 0) AS reserved,
        COALESCE(h.holds, 0) AS holds,
        GREATEST(fs.capacity - COALESCE(r.reserved,0) - COALESCE(h.holds,0), 0) AS remaining
      FROM formation_sessions fs
      LEFT JOIN (
        SELECT formation_session_id, COUNT(*) AS reserved
        FROM reservations
        WHERE formation_session_id IS NOT NULL AND status IN ('paid','confirmed')
        GROUP BY formation_session_id
      ) r ON r.formation_session_id = fs.id
      LEFT JOIN (
        SELECT formation_session_id, COUNT(*) AS holds
        FROM reservation_holds
        WHERE formation_session_id IS NOT NULL AND expires_at > NOW()
        GROUP BY formation_session_id
      ) h ON h.formation_session_id = fs.id
      ${sqlWhere}
      ORDER BY fs.start_date DESC, fs.id DESC
      `,
      params
    );

    return res.json(rows);
  } catch (e) {
    console.error("listAdminSessions:", e);
    return res.status(500).json({ message: "Erreur sessions (admin)" });
  }
}

async function createAdminSession(req, res) {
  const b = req.body || {};
  const formation_code  = (b.formation_code  || "").trim();
  const formation_label = (b.formation_label || "").trim();
  const price_eur   = Number(b.price_eur  ?? 0);
  const days_count  = Number(b.days_count  ?? 1);
  const start_date  = (b.start_date || "").trim();
  const slot_policy = (b.slot_policy || "both").trim();
  const status      = (b.status || "draft").trim();
  const note        = b.note ?? null;
  const capacity    = Number(b.capacity ?? 1);

  if (!formation_code)  return res.status(400).json({ message: "formation_code requis" });
  if (!formation_label) return res.status(400).json({ message: "formation_label requis" });
  if (!start_date)      return res.status(400).json({ message: "start_date requis (YYYY-MM-DD)" });
  if (!Number.isFinite(price_eur) || price_eur < 0) return res.status(400).json({ message: "price_eur invalide" });
  if (!Number.isFinite(days_count) || days_count < 1 || days_count > 60) return res.status(400).json({ message: "days_count invalide (1..60)" });
  if (!["morning","afternoon","both","early_morning"].includes(slot_policy)) return res.status(400).json({ message: "slot_policy invalide" });
  if (!["draft","published","closed"].includes(status)) return res.status(400).json({ message: "status invalide" });
  if (!Number.isFinite(capacity) || capacity < 1) return res.status(400).json({ message: "capacity invalide (>=1)" });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [r] = await conn.query(
      `INSERT INTO formation_sessions
       (formation_code, formation_label, price_eur, days_count, start_date, slot_policy, status, note, capacity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [formation_code, formation_label, price_eur, days_count, start_date, slot_policy, status, note, capacity]
    );

    await regenerateSessionDates(conn, r.insertId, start_date, days_count);
    await conn.commit();
    return res.status(201).json({ ok: true, id: r.insertId });
  } catch (e) {
    await conn.rollback();
    console.error("createAdminSession:", e);
    return res.status(500).json({ message: "Erreur création session", details: e?.code || e?.message });
  } finally {
    conn.release();
  }
}

async function updateAdminSession(req, res) {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ message: "id invalide" });

  const b = req.body || {};
  const fields = [];
  const params = [];

  const addField = (col, val) => { fields.push(`${col}=?`); params.push(val); };

  if (b.formation_code  !== undefined) addField("formation_code",  String(b.formation_code).trim());
  if (b.formation_label !== undefined) addField("formation_label", String(b.formation_label).trim());
  if (b.price_eur !== undefined) {
    const v = Number(b.price_eur);
    if (!Number.isFinite(v) || v < 0) return res.status(400).json({ message: "price_eur invalide" });
    addField("price_eur", v);
  }
  if (b.days_count !== undefined) {
    const v = Number(b.days_count);
    if (!Number.isFinite(v) || v < 1 || v > 60) return res.status(400).json({ message: "days_count invalide (1..60)" });
    addField("days_count", v);
  }
  if (b.start_date !== undefined) addField("start_date", String(b.start_date).trim());
  if (b.slot_policy !== undefined) {
    const v = String(b.slot_policy).trim();
    if (!["morning","afternoon","both","early_morning"].includes(v)) return res.status(400).json({ message: "slot_policy invalide" });
    addField("slot_policy", v);
  }
  if (b.status !== undefined) {
    const v = String(b.status).trim();
    if (!["draft","published","closed"].includes(v)) return res.status(400).json({ message: "status invalide" });
    addField("status", v);
  }
  if (b.capacity !== undefined) {
    const v = Number(b.capacity);
    if (!Number.isFinite(v) || v < 1) return res.status(400).json({ message: "capacity invalide" });
    addField("capacity", v);
  }
  if (b.note !== undefined) addField("note", b.note);

  if (!fields.length) return res.status(400).json({ message: "Aucun champ à modifier" });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[before]] = await conn.query(
      "SELECT start_date, days_count FROM formation_sessions WHERE id=?", [id]
    );
    if (!before) { await conn.rollback(); return res.status(404).json({ message: "Session introuvable" }); }

    params.push(id);
    await conn.query(`UPDATE formation_sessions SET ${fields.join(", ")} WHERE id=?`, params);

    const [[after]] = await conn.query(
      "SELECT start_date, days_count FROM formation_sessions WHERE id=?", [id]
    );

    if (String(after.start_date) !== String(before.start_date) ||
        Number(after.days_count) !== Number(before.days_count)) {
      await regenerateSessionDates(conn, id, after.start_date, Number(after.days_count));
    }

    await conn.commit();
    return res.json({ ok: true });
  } catch (e) {
    await conn.rollback();
    console.error("updateAdminSession:", e);
    return res.status(500).json({ message: "Erreur update session", details: e?.code || e?.message });
  } finally {
    conn.release();
  }
}

async function deleteAdminSession(req, res) {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ message: "id invalide" });
  try {
    await db.query("DELETE FROM formation_sessions WHERE id=?", [id]);
    return res.json({ ok: true });
  } catch (e) {
    console.error("deleteAdminSession:", e);
    return res.status(500).json({ message: "Erreur suppression session" });
  }
}

module.exports = {
  requireAdmin,
  // public
  listPublicFormations,   // ← NOUVEAU
  listPublicSessions,
  getPublicSessionById,
  // admin
  listAdminSessions,
  createAdminSession,
  updateAdminSession,
  deleteAdminSession,
}; 