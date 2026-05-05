// back/src/controllers/catalogController.js
const db = require("../../db");

function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
}

function str(v) {
  return String(v ?? "").trim();
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function int(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function cleanStatus(v, fallback = "draft") {
  const value = str(v) || fallback;
  return ["draft", "published", "archived"].includes(value) ? value : fallback;
}

function cleanCategory(v) {
  const value = str(v) || "autre";
  return ["auto", "perfectionnement", "intensif", "promo", "professionnelle", "autre"].includes(value)
    ? value
    : "autre";
}

// ═══════════════════════════════════════════════════════════
// FORMATIONS — PUBLIC
// ═══════════════════════════════════════════════════════════
async function listPublicFormations(req, res) {
  try {
    const [rows] = await db.query(`
      SELECT
        f.id,
        f.code AS formation_code,
        f.title AS formation_label,
        f.description,
        f.price_eur,
        f.days_count,
        f.duration_label,
        f.category,
        f.kit_included,
        f.image_url,
        f.sort_order,
        f.status,
        COALESCE(sess.remaining_total, 0) AS remaining
      FROM formations f
      LEFT JOIN (
        SELECT
          fs.formation_code,
          SUM(GREATEST(fs.capacity - COALESCE(r.reserved,0) - COALESCE(h.holds,0), 0)) AS remaining_total
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
        WHERE fs.status='published' AND fs.start_date >= CURDATE()
        GROUP BY fs.formation_code
      ) sess ON sess.formation_code = f.code
      WHERE f.status='published'
      ORDER BY f.sort_order ASC, f.price_eur ASC, f.id ASC
    `);
    return res.json(rows);
  } catch (e) {
    console.error("listPublicFormations:", e);
    return res.status(500).json({ message: "Erreur catalogue formations" });
  }
}

// ═══════════════════════════════════════════════════════════
// FORMATIONS — ADMIN CRUD
// ═══════════════════════════════════════════════════════════
async function listAdminFormations(req, res) {
  try {
    const [rows] = await db.query(`
      SELECT
        id,
        code,
        title,
        description,
        price_eur,
        days_count,
        duration_label,
        category,
        kit_included,
        image_url,
        status,
        sort_order,
        created_at,
        updated_at
      FROM formations
      ORDER BY sort_order ASC, id DESC
    `);
    return res.json(rows);
  } catch (e) {
    console.error("listAdminFormations:", e);
    return res.status(500).json({ message: "Erreur admin formations" });
  }
}

async function createAdminFormation(req, res) {
  const b = req.body || {};
  const code = str(b.code).toUpperCase();
  const title = str(b.title);
  const description = str(b.description) || null;
  const price_eur = num(b.price_eur, -1);
  const days_count = int(b.days_count, 0);
  const duration_label = str(b.duration_label) || null;
  const category = cleanCategory(b.category);
  const kit_included = b.kit_included ? 1 : 0;
  const image_url = str(b.image_url) || null;
  const status = cleanStatus(b.status, "draft");
  const sort_order = int(b.sort_order, 0);

  if (!code) return res.status(400).json({ message: "code requis" });
  if (!title) return res.status(400).json({ message: "titre requis" });
  if (!Number.isFinite(price_eur) || price_eur < 0) return res.status(400).json({ message: "prix invalide" });
  if (!Number.isFinite(days_count) || days_count < 1 || days_count > 365) return res.status(400).json({ message: "durée invalide" });

  try {
    const [r] = await db.query(
      `INSERT INTO formations
       (code, title, description, price_eur, days_count, duration_label, category, kit_included, image_url, status, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [code, title, description, price_eur, days_count, duration_label, category, kit_included, image_url, status, sort_order]
    );
    return res.status(201).json({ ok: true, id: r.insertId });
  } catch (e) {
    console.error("createAdminFormation:", e);
    if (e.code === "ER_DUP_ENTRY") return res.status(409).json({ message: "Ce code formation existe déjà" });
    return res.status(500).json({ message: "Erreur création formation", details: e?.code || e?.message });
  }
}

async function updateAdminFormation(req, res) {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ message: "id invalide" });

  const b = req.body || {};
  const fields = [];
  const params = [];
  const add = (col, val) => { fields.push(`${col}=?`); params.push(val); };

  if (b.code !== undefined) {
    const code = str(b.code).toUpperCase();
    if (!code) return res.status(400).json({ message: "code requis" });
    add("code", code);
  }
  if (b.title !== undefined) {
    const title = str(b.title);
    if (!title) return res.status(400).json({ message: "titre requis" });
    add("title", title);
  }
  if (b.description !== undefined) add("description", str(b.description) || null);
  if (b.price_eur !== undefined) {
    const v = num(b.price_eur, -1);
    if (!Number.isFinite(v) || v < 0) return res.status(400).json({ message: "prix invalide" });
    add("price_eur", v);
  }
  if (b.days_count !== undefined) {
    const v = int(b.days_count, 0);
    if (!Number.isFinite(v) || v < 1 || v > 365) return res.status(400).json({ message: "durée invalide" });
    add("days_count", v);
  }
  if (b.duration_label !== undefined) add("duration_label", str(b.duration_label) || null);
  if (b.category !== undefined) add("category", cleanCategory(b.category));
  if (b.kit_included !== undefined) add("kit_included", b.kit_included ? 1 : 0);
  if (b.image_url !== undefined) add("image_url", str(b.image_url) || null);
  if (b.status !== undefined) add("status", cleanStatus(b.status));
  if (b.sort_order !== undefined) add("sort_order", int(b.sort_order, 0));

  if (!fields.length) return res.status(400).json({ message: "Aucun champ à modifier" });
  params.push(id);

  try {
    const [r] = await db.query(`UPDATE formations SET ${fields.join(", ")} WHERE id=?`, params);
    if (r.affectedRows === 0) return res.status(404).json({ message: "Formation introuvable" });
    return res.json({ ok: true });
  } catch (e) {
    console.error("updateAdminFormation:", e);
    if (e.code === "ER_DUP_ENTRY") return res.status(409).json({ message: "Ce code formation existe déjà" });
    return res.status(500).json({ message: "Erreur modification formation", details: e?.code || e?.message });
  }
}

async function deleteAdminFormation(req, res) {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ message: "id invalide" });

  try {
    const [[f]] = await db.query("SELECT code FROM formations WHERE id=?", [id]);
    if (!f) return res.status(404).json({ message: "Formation introuvable" });

    const [[activeSessions]] = await db.query(
      "SELECT COUNT(*) AS total FROM formation_sessions WHERE formation_code=?",
      [f.code]
    );

    if (Number(activeSessions.total) > 0) {
      await db.query("UPDATE formations SET status='archived' WHERE id=?", [id]);
      return res.json({ ok: true, archived: true, message: "Formation archivée car elle possède des sessions" });
    }

    await db.query("DELETE FROM formations WHERE id=?", [id]);
    return res.json({ ok: true, deleted: true });
  } catch (e) {
    console.error("deleteAdminFormation:", e);
    return res.status(500).json({ message: "Erreur suppression formation", details: e?.code || e?.message });
  }
}

// ═══════════════════════════════════════════════════════════
// SERVICES / PRESTATIONS — PUBLIC
// ═══════════════════════════════════════════════════════════
async function listPublicServices(req, res) {
  try {
    const [rows] = await db.query(`
      SELECT id, code, name, description, price_eur, deposit_percent, duration_label, image_url, sort_order, status
      FROM services
      WHERE status='published'
      ORDER BY sort_order ASC, price_eur ASC, id ASC
    `);
    return res.json(rows);
  } catch (e) {
    console.error("listPublicServices:", e);
    return res.status(500).json({ message: "Erreur catalogue prestations" });
  }
}

// ═══════════════════════════════════════════════════════════
// SERVICES / PRESTATIONS — ADMIN CRUD
// ═══════════════════════════════════════════════════════════
async function listAdminServices(req, res) {
  try {
    const [rows] = await db.query(`
      SELECT id, code, name, description, price_eur, deposit_percent, duration_label, image_url, status, sort_order, created_at, updated_at
      FROM services
      ORDER BY sort_order ASC, id DESC
    `);
    return res.json(rows);
  } catch (e) {
    console.error("listAdminServices:", e);
    return res.status(500).json({ message: "Erreur admin prestations" });
  }
}

async function createAdminService(req, res) {
  const b = req.body || {};
  const code = str(b.code).toUpperCase();
  const name = str(b.name);
  const description = str(b.description) || null;
  const price_eur = num(b.price_eur, -1);
  const deposit_percent = int(b.deposit_percent != null ? b.deposit_percent : 50, 50);
  const duration_label = str(b.duration_label) || null;
  const image_url = str(b.image_url) || null;
  const status = cleanStatus(b.status, "draft");
  const sort_order = int(b.sort_order, 0);

  if (!code) return res.status(400).json({ message: "code requis" });
  if (!name) return res.status(400).json({ message: "nom requis" });
  if (!Number.isFinite(price_eur) || price_eur < 0) return res.status(400).json({ message: "prix invalide" });
  if (deposit_percent < 0 || deposit_percent > 100) return res.status(400).json({ message: "deposit_percent invalide (0-100)" });

  try {
    const [r] = await db.query(
      `INSERT INTO services
       (code, name, description, price_eur, deposit_percent, duration_label, image_url, status, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [code, name, description, price_eur, deposit_percent, duration_label, image_url, status, sort_order]
    );
    return res.status(201).json({ ok: true, id: r.insertId });
  } catch (e) {
    console.error("createAdminService:", e);
    if (e.code === "ER_DUP_ENTRY") return res.status(409).json({ message: "Ce code prestation existe déjà" });
    return res.status(500).json({ message: "Erreur création prestation", details: e?.code || e?.message });
  }
}

async function updateAdminService(req, res) {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ message: "id invalide" });

  const b = req.body || {};
  const fields = [];
  const params = [];
  const add = (col, val) => { fields.push(`${col}=?`); params.push(val); };

  if (b.code !== undefined) {
    const code = str(b.code).toUpperCase();
    if (!code) return res.status(400).json({ message: "code requis" });
    add("code", code);
  }
  if (b.name !== undefined) {
    const name = str(b.name);
    if (!name) return res.status(400).json({ message: "nom requis" });
    add("name", name);
  }
  if (b.description !== undefined) add("description", str(b.description) || null);
  if (b.price_eur !== undefined) {
    const v = num(b.price_eur, -1);
    if (!Number.isFinite(v) || v < 0) return res.status(400).json({ message: "prix invalide" });
    add("price_eur", v);
  }
  if (b.deposit_percent !== undefined) {
    const v = int(b.deposit_percent, 50);
    if (v < 0 || v > 100) return res.status(400).json({ message: "deposit_percent invalide (0-100)" });
    add("deposit_percent", v);
  }
  if (b.duration_label !== undefined) add("duration_label", str(b.duration_label) || null);
  if (b.image_url !== undefined) add("image_url", str(b.image_url) || null);
  if (b.status !== undefined) add("status", cleanStatus(b.status));
  if (b.sort_order !== undefined) add("sort_order", int(b.sort_order, 0));

  if (!fields.length) return res.status(400).json({ message: "Aucun champ à modifier" });
  params.push(id);

  try {
    const [r] = await db.query(`UPDATE services SET ${fields.join(", ")} WHERE id=?`, params);
    if (r.affectedRows === 0) return res.status(404).json({ message: "Prestation introuvable" });
    return res.json({ ok: true });
  } catch (e) {
    console.error("updateAdminService:", e);
    if (e.code === "ER_DUP_ENTRY") return res.status(409).json({ message: "Ce code prestation existe déjà" });
    return res.status(500).json({ message: "Erreur modification prestation", details: e?.code || e?.message });
  }
}

async function deleteAdminService(req, res) {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ message: "id invalide" });

  try {
    const [r] = await db.query("DELETE FROM services WHERE id=?", [id]);
    if (r.affectedRows === 0) return res.status(404).json({ message: "Prestation introuvable" });
    return res.json({ ok: true });
  } catch (e) {
    console.error("deleteAdminService:", e);
    return res.status(500).json({ message: "Erreur suppression prestation", details: e?.code || e?.message });
  }
}

module.exports = {
  requireAdmin,
  listPublicFormations,
  listAdminFormations,
  createAdminFormation,
  updateAdminFormation,
  deleteAdminFormation,
  listPublicServices,
  listAdminServices,
  createAdminService,
  updateAdminService,
  deleteAdminService,
};
