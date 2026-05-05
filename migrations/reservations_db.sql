-- ═════════════════════════════════════════════════════════════
-- RKbeauty — Base MySQL complète
-- Paiement unique : Stripe
-- Flux 1 : prestations/service simples avec acompte 50%
-- Flux 2 : formations multi-jours avec sessions publiées par l'admin
-- ═════════════════════════════════════════════════════════════

CREATE DATABASE IF NOT EXISTS reservations_db
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE reservations_db;

-- ─────────────────────────────────────────────────────────────
-- Réservations finalisées après validation Stripe webhook
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reservations (
  id                        INT AUTO_INCREMENT PRIMARY KEY,
  date                      DATE NOT NULL,
  slot                      ENUM('morning','afternoon') NOT NULL,
  type                      ENUM('service','formation') NOT NULL DEFAULT 'service',
  meta                      JSON NULL,
  status                    ENUM('pending','paid','cancelled') NOT NULL DEFAULT 'pending',
  paid_at                   DATETIME NULL,
  formation                 VARCHAR(255) NULL COMMENT 'Nom formation ou prestation',
  amount                    INT NULL COMMENT 'Montant payé en centimes',
  currency                  VARCHAR(10) NULL DEFAULT 'eur',
  stripe_session_id         VARCHAR(255) NULL,
  stripe_payment_intent_id  VARCHAR(255) NULL,
  formation_session_id      INT NULL,
  created_at                TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  user_id                   INT NULL,
  INDEX idx_date_slot_type  (date, slot, type),
  INDEX idx_status          (status),
  INDEX idx_stripe          (stripe_session_id),
  INDEX idx_formation_session (formation_session_id)
);

-- ─────────────────────────────────────────────────────────────
-- Quotas par défaut par type et par créneau
-- service : prestations maquillage
-- formation : sessions de formation
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quotas (
  type        ENUM('service','formation') NOT NULL DEFAULT 'service',
  slot        ENUM('morning','afternoon') NOT NULL,
  max_places  INT NOT NULL DEFAULT 6,
  PRIMARY KEY (type, slot)
);

INSERT INTO quotas (type, slot, max_places)
VALUES
  ('service', 'morning', 6),
  ('service', 'afternoon', 6),
  ('formation', 'morning', 6),
  ('formation', 'afternoon', 6)
ON DUPLICATE KEY UPDATE max_places = VALUES(max_places);

-- ─────────────────────────────────────────────────────────────
-- Catalogue des formations administrables depuis rk-admin-2025.html
-- L'admin peut créer/modifier/archiver une formation sans toucher au code.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS formations (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  code            VARCHAR(50) NOT NULL,
  title           VARCHAR(255) NOT NULL,
  description     TEXT NULL,
  price_eur       DECIMAL(10,2) NOT NULL DEFAULT 0,
  days_count      INT NOT NULL DEFAULT 1,
  duration_label  VARCHAR(100) NULL,
  category        ENUM('auto','perfectionnement','intensif','promo','professionnelle','autre') NOT NULL DEFAULT 'autre',
  kit_included    TINYINT(1) NOT NULL DEFAULT 0,
  image_url       VARCHAR(500) NULL,
  status          ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
  sort_order      INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_formations_code (code),
  INDEX idx_formations_status (status),
  INDEX idx_formations_sort (sort_order)
);

INSERT INTO formations
  (code, title, description, price_eur, days_count, duration_label, category, kit_included, status, sort_order)
VALUES
  ('F2J-100', 'Formation Auto-Maquillage — 2 jours', 'Apprendre à se maquiller seule avec une méthode simple, adaptée au visage, à la peau et au quotidien.', 100, 2, '6h (3h/jour × 2 jours)', 'auto', 0, 'published', 10),
  ('F2J-150', 'Formation Perfectionnement Maquilleuse — 2 jours', 'Perfectionnement destiné aux personnes ayant déjà une base en maquillage : teint, yeux, morphologie, gestes professionnels.', 150, 2, '6h (3h/jour × 2 jours)', 'perfectionnement', 0, 'published', 20),
  ('F4J-200', 'Formation Auto-Maquillage — 4 jours', 'Programme complet pour maîtriser son auto-maquillage : peau, teint, yeux, sourcils, lèvres et routine produits.', 200, 4, '12h (3h/jour × 4 jours)', 'auto', 0, 'published', 30),
  ('F4J-250', 'Formation Perfectionnement Pro — 4 jours', 'Formation avancée pour maquilleuses qui souhaitent gagner en précision, rapidité et qualité de finition.', 250, 4, '12h (3h/jour × 4 jours)', 'perfectionnement', 0, 'published', 40),
  ('F7J-300', 'Formation Auto-Maquillage Pro — 7 jours', 'Pack approfondi pour maîtriser plusieurs styles : naturel, soirée, sophistiqué et événementiel.', 300, 7, '21h (3h/jour × 7 jours)', 'auto', 0, 'published', 50),
  ('F7J-350', 'Formation Perfectionnement Pro — 7 jours', 'Parcours complet pour perfectionner son niveau technique et développer une vision professionnelle du maquillage.', 350, 7, '21h (3h/jour × 7 jours)', 'perfectionnement', 0, 'published', 60),
  ('F2S-600', 'Formation Auto-Maquillage — 2 semaines', 'Formation longue pour gagner en autonomie, maîtriser plusieurs looks et structurer sa routine beauté.', 600, 14, '42h (3h/jour × 14 jours)', 'auto', 0, 'published', 70),
  ('F2S-650', 'Formation Perfectionnement — 2 semaines', 'Perfectionnement intensif multi-styles avec pratique, corrections personnalisées et certificat.', 650, 14, '42h (3h/jour × 14 jours)', 'perfectionnement', 0, 'published', 80),
  ('F4S-1300', 'Formation Professionnelle — 1 mois', 'Formation complète pour développer une maîtrise professionnelle et préparer une activité en clientèle.', 1300, 28, '90h (environ 3h/jour)', 'professionnelle', 0, 'published', 90),
  ('I7J-650', 'Formation Maquillage Intensif — 7 jours avec kit', 'Formation intensive accélérée avec kit maquillage professionnel inclus.', 650, 7, '21h (3h/jour × 7 jours)', 'intensif', 1, 'published', 100),
  ('I14J-900', 'Formation Maquillage Intensif — 14 jours avec kit', 'Immersion intensive avec kit complet, pratique guidée et accompagnement premium.', 900, 14, '42h (3h/jour × 14 jours)', 'intensif', 1, 'published', 110),
  ('P7J-250', 'Promo spéciale — 7 jours', 'Offre promotionnelle 7 jours pour une période limitée.', 250, 7, '21h (3h/jour × 7 jours)', 'promo', 0, 'published', 120),
  ('P2S-350', 'Promo spéciale — 14 jours', 'Offre promotionnelle 14 jours pour une période limitée.', 350, 14, '42h (3h/jour × 14 jours)', 'promo', 0, 'published', 130)
ON DUPLICATE KEY UPDATE
  title=VALUES(title),
  description=VALUES(description),
  price_eur=VALUES(price_eur),
  days_count=VALUES(days_count),
  duration_label=VALUES(duration_label),
  category=VALUES(category),
  kit_included=VALUES(kit_included),
  status=VALUES(status),
  sort_order=VALUES(sort_order);

-- ─────────────────────────────────────────────────────────────
-- Catalogue des prestations/services administrables
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS services (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  code            VARCHAR(50) NOT NULL,
  name            VARCHAR(255) NOT NULL,
  description     TEXT NULL,
  price_eur       DECIMAL(10,2) NOT NULL DEFAULT 0,
  deposit_percent INT NOT NULL DEFAULT 50 COMMENT 'Pourcentage d''acompte (0-100)',
  duration_label  VARCHAR(100) NULL,
  image_url       VARCHAR(500) NULL,
  status          ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
  sort_order      INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_services_code (code),
  INDEX idx_services_status (status),
  INDEX idx_services_sort (sort_order)
);

INSERT INTO services
  (code, name, description, price_eur, deposit_percent, duration_label, status, sort_order)
VALUES
  ('NUDE', 'Maquillage Nude', 'Look naturel qui unifie le teint et rehausse légèrement les traits.', 50, 50, '1h', 'published', 10),
  ('SOFT-GLAM', 'Maquillage Soft Glam', 'Maquillage élégant et féminin avec tons neutres, ombres douces et touche de glamour.', 60, 50, '1h30', 'published', 20),
  ('SOFT-SOPH', 'Maquillage Soft Glam Sophistiqué', 'Version plus travaillée et raffinée du Soft Glam classique.', 70, 50, '1h30', 'published', 30),
  ('SOPHISTIQUE', 'Maquillage Sophistiqué', 'Maquillage élégant et plus intense, notamment au niveau des yeux.', 80, 50, '1h30', 'published', 40)
ON DUPLICATE KEY UPDATE
  name=VALUES(name),
  description=VALUES(description),
  price_eur=VALUES(price_eur),
  deposit_percent=VALUES(deposit_percent),
  duration_label=VALUES(duration_label),
  status=VALUES(status),
  sort_order=VALUES(sort_order);

-- ─────────────────────────────────────────────────────────────
-- Blocages et quotas personnalisés par date/type/créneau
-- Admin : /admin/schedule?date=YYYY-MM-DD&type=service|formation
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schedule_overrides (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  date        DATE NOT NULL,
  type        ENUM('service','formation') NOT NULL DEFAULT 'formation',
  slot        ENUM('morning','afternoon') NOT NULL,
  `open`      TINYINT(1) NOT NULL DEFAULT 1,
  quota       INT NULL COMMENT 'NULL = utiliser quota par défaut',
  note        VARCHAR(255) NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_date_type_slot (date, type, slot)
);

-- ─────────────────────────────────────────────────────────────
-- Sessions de formation créées par l'admin
-- Le client ne choisit pas une date libre : il choisit une session publiée
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS formation_sessions (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  formation_code   VARCHAR(50) NOT NULL COMMENT 'Ex: F2J-150, F4J-250, F2S-600',
  formation_label  VARCHAR(255) NOT NULL,
  price_eur        DECIMAL(10,2) NOT NULL DEFAULT 0,
  days_count       INT NOT NULL DEFAULT 1,
  start_date       DATE NOT NULL,
  slot_policy      ENUM('morning','afternoon','both') NOT NULL DEFAULT 'both',
  status           ENUM('draft','published','closed') NOT NULL DEFAULT 'draft',
  capacity         INT NOT NULL DEFAULT 1 COMMENT 'Nombre de places pour la session',
  note             TEXT NULL,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_code   (formation_code),
  INDEX idx_status (status),
  INDEX idx_date   (start_date),
  UNIQUE KEY uq_session_code_start (formation_code, start_date)
);

-- ─────────────────────────────────────────────────────────────
-- Dates réelles d'une session multi-jours
-- Exemple : formation 4 jours => 4 lignes dans cette table
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS formation_session_dates (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  session_id    INT NOT NULL,
  session_date  DATE NOT NULL,
  UNIQUE KEY uq_session_date (session_id, session_date),
  FOREIGN KEY (session_id)
    REFERENCES formation_sessions(id)
    ON DELETE CASCADE
);

-- ─────────────────────────────────────────────────────────────
-- Réservations temporaires pendant Stripe Checkout
-- Expiration : 15 minutes
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reservation_holds (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  group_id              VARCHAR(100) NOT NULL,
  formation_session_id  INT NULL,
  date                  DATE NOT NULL,
  slot                  ENUM('morning','afternoon') NOT NULL,
  type                  ENUM('service','formation') NOT NULL DEFAULT 'formation',
  formation             VARCHAR(255) NULL COMMENT 'Nom formation ou prestation',
  amount                INT NULL COMMENT 'Montant payé en centimes',
  currency              VARCHAR(10) NULL DEFAULT 'eur',
  stripe_session_id     VARCHAR(255) NULL,
  expires_at            DATETIME NOT NULL,
  meta                  JSON NULL,
  created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_group       (group_id),
  INDEX idx_expires     (expires_at),
  INDEX idx_fsession    (formation_session_id),
  INDEX idx_date_slot_type (date, slot, type)
);
