require("dotenv").config();

const express = require("express");
const cors = require("cors");

const paymentsRoutes = require("./src/routes/payments");
const availabilityRoutes = require("./src/routes/availability");
const adminScheduleRoutes = require("./src/routes/adminSchedule");
const catalogRoutes = require("./src/routes/catalog");
const formationSessionsRoutes = require("./src/routes/formationSessions");
const reservationsRoutes = require("./src/routes/reservations");
const { stripeWebhook } = require("./src/controllers/paymentsController");

const app = express();

// ─────────────────────────────────────────────────────────────
// CORS
// Ajoutez vos URLs Netlify/locales dans FRONT_URL, FRONT_BASE_URL ou CORS_ORIGINS.
// CORS_ORIGINS peut contenir plusieurs URLs séparées par des virgules.
// ─────────────────────────────────────────────────────────────
const allowed = new Set(
  [
    process.env.FRONT_URL,
    process.env.FRONT_BASE_URL,
    ...(process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
    "http://localhost:5500",
    "http://127.0.0.1:5500",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3001",
  ].filter(Boolean)
);

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // Postman, curl, Stripe webhook
    if (allowed.has(origin)) return cb(null, true);
    return cb(new Error("CORS blocked: " + origin));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-admin-token"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Le webhook Stripe doit rester AVANT express.json()
app.post(
  "/payments/webhook",
  express.raw({ type: "application/json" }),
  stripeWebhook
);

app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "ok", app: "RKbeauty API" });
});

// Catalogue public/admin : /formations, /services, /admin/formations, /admin/services
app.use("/", catalogRoutes);

// Sessions formations : /formation-sessions, /admin/formation-sessions
app.use("/", formationSessionsRoutes);

// Disponibilités publiques : /availability?date=YYYY-MM-DD&type=service|formation
app.use("/availability", availabilityRoutes);

// Réservations : dashboard admin + recherche client
app.use("/", reservationsRoutes);

// Paiements Stripe : formations + prestations
app.use("/payments", paymentsRoutes);

// Admin planning : /admin/schedule?date=YYYY-MM-DD&type=service|formation
app.use("/admin", adminScheduleRoutes);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log("✅ RKbeauty API running on port", PORT));
