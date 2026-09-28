-- Additive version setting: preserves existing version references and report history.
-- Automatic acceptance bypasses the dispatcher and cannot use an AI connection.
ALTER TABLE `work_type_versions` ADD `auto_accept_report` integer DEFAULT false NOT NULL
  CONSTRAINT `work_type_versions_auto_accept_check` CHECK (
    `auto_accept_report` IN (0, 1) AND
    (`auto_accept_report` = 0 OR (`verification_mode` = 'dispatcher' AND `ai_verifier_connection_id` IS NULL))
  );
