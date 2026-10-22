ALTER TABLE chat_sessions ADD COLUMN title_locked BOOLEAN DEFAULT 0 NOT NULL
-- ;;
UPDATE alembic_version SET version_num='00000027' WHERE alembic_version.version_num = '00000026'
