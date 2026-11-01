ALTER TABLE chat_sessions ADD COLUMN credential_id VARCHAR(64)
-- ;;
UPDATE alembic_version SET version_num='00000030' WHERE alembic_version.version_num = '00000029'
