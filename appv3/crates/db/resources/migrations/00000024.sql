ALTER TABLE chat_sessions ADD COLUMN pinned_at DATETIME
-- ;;
CREATE INDEX ix_chat_sessions_top_updated ON chat_sessions (parent_session_id, updated_at, id)
-- ;;
CREATE INDEX ix_chat_sessions_top_workspace_updated ON chat_sessions (parent_session_id, workspace, updated_at, id)
-- ;;
UPDATE alembic_version SET version_num='00000024' WHERE alembic_version.version_num = '00000023'
