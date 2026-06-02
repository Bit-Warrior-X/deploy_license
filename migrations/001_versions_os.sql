-- Run once on existing databases created before the os column was added to schema.sql
USE lic;

ALTER TABLE `versions`
  ADD COLUMN `os` VARCHAR(64) DEFAULT NULL COMMENT 'Target OS label, e.g. ubuntu-22.04'
  AFTER `version`;
