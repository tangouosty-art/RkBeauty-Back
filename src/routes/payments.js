const router = require("express").Router();

const {
  createCheckoutSession,
  createServiceCheckoutSession,
  getCheckoutSessionStatus,
  cancelGroup,
} = require("../controllers/paymentsController");

// Formations multi-jours : nécessite formation_session_id
router.post("/create-checkout-session", createCheckoutSession);

// Prestations simples : service + acompte 50%
router.post("/create-service-checkout-session", createServiceCheckoutSession);

// Confirmation après retour Stripe
router.get("/session/:sessionId", getCheckoutSessionStatus);

// Annulation : libère les holds temporaires
router.post("/cancel/:groupId", cancelGroup);

module.exports = router;
