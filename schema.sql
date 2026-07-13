CREATE DATABASE IF NOT EXISTS lic;
USE lic;

CREATE TABLE IF NOT EXISTS `license` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `uuid` VARCHAR(64) NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `ip` VARCHAR(64) NOT NULL,
  `user` VARCHAR(128) NOT NULL,
  `password` VARCHAR(255) NOT NULL,
  `ssh_port` INT NOT NULL,
  `machine_id` VARCHAR(255) DEFAULT NULL,
  `license` TEXT NOT NULL,
  `pub_key` TEXT DEFAULT NULL,
  `private_key` TEXT DEFAULT NULL,
  `token` VARCHAR(255) DEFAULT NULL,
  `expire_date` DATETIME DEFAULT NULL,
  `created` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_license_uuid` (`uuid`),
  KEY `idx_license_machine_id` (`machine_id`),
  KEY `idx_license_token` (`token`),
  KEY `idx_license_ip` (`ip`(32))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `versions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `uuid` VARCHAR(64) NOT NULL,
  `version` VARCHAR(128) DEFAULT NULL,
  `os` VARCHAR(64) DEFAULT NULL COMMENT 'Target OS label, e.g. ubuntu-22.04',
  `full_name` VARCHAR(255) DEFAULT NULL,
  `path` VARCHAR(500) DEFAULT NULL,
  `created` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_versions_version_os` (`version`, `os`),
  KEY `idx_versions_uuid` (`uuid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `history` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `uuid` VARCHAR(64) NOT NULL,
  `description` TEXT NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_history_uuid` (`uuid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;