-- One catalog row per product version and target OS (not per content uuid).
-- Previously uk_versions_uuid caused later uploads with the same placeholder
-- filename hash to overwrite the row for the other OS.
-- Safe to re-run (MariaDB 10.0.2+).
USE lic;

ALTER TABLE `versions` DROP INDEX IF EXISTS `uk_versions_uuid`;

SET @has_version_os_idx := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'versions'
    AND index_name = 'uk_versions_version_os'
);

SET @add_version_os_sql := IF(
  @has_version_os_idx > 0,
  'SELECT ''uk_versions_version_os already exists''',
  'ALTER TABLE `versions` ADD UNIQUE KEY `uk_versions_version_os` (`version`, `os`)'
);
PREPARE add_version_os_stmt FROM @add_version_os_sql;
EXECUTE add_version_os_stmt;
DEALLOCATE PREPARE add_version_os_stmt;

SET @has_uuid_idx := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'versions'
    AND index_name = 'idx_versions_uuid'
);

SET @add_uuid_idx_sql := IF(
  @has_uuid_idx > 0,
  'SELECT ''idx_versions_uuid already exists''',
  'ALTER TABLE `versions` ADD KEY `idx_versions_uuid` (`uuid`)'
);
PREPARE add_uuid_idx_stmt FROM @add_uuid_idx_sql;
EXECUTE add_uuid_idx_stmt;
DEALLOCATE PREPARE add_uuid_idx_stmt;
