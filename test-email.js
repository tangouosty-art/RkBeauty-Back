require("dotenv").config();
const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

transporter.verify((err, success) => {
  if (err) {
    console.error("❌ Erreur SMTP :", err.message);
  } else {
    console.log("✅ Connexion SMTP OK");
    transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: process.env.SMTP_USER,
      subject: "Test RKbeauty",
      text: "Email de test RKbeauty — ça marche !",
    }, (err2, info) => {
      if (err2) console.error("❌ Envoi échoué :", err2.message);
      else console.log("✅ Email envoyé :", info.response);
    });
  }
});