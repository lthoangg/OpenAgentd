CREATE TABLE workspace_groups (
	id CHAR(32) NOT NULL,
	name VARCHAR(80) NOT NULL,
	brief TEXT,
	color VARCHAR(16),
	created_at DATETIME NOT NULL,
	updated_at DATETIME NOT NULL,
	PRIMARY KEY (id)
)
-- ;;
CREATE UNIQUE INDEX uq_workspace_groups_name ON workspace_groups (name COLLATE NOCASE)
-- ;;
CREATE TABLE workspace_group_members (
	group_id CHAR(32) NOT NULL REFERENCES workspace_groups (id) ON DELETE CASCADE,
	path VARCHAR NOT NULL,
	created_at DATETIME NOT NULL,
	PRIMARY KEY (group_id, path)
)
-- ;;
CREATE INDEX ix_workspace_group_members_path ON workspace_group_members (path)
-- ;;
ALTER TABLE chat_sessions ADD COLUMN last_message_at DATETIME
-- ;;
UPDATE chat_sessions SET last_message_at = COALESCE((SELECT MAX(m.created_at) FROM session_messages m WHERE m.session_id = chat_sessions.id AND m.kind != 'summary'), created_at)
-- ;;
DROP INDEX ix_chat_sessions_top_updated
-- ;;
DROP INDEX ix_chat_sessions_top_workspace_updated
-- ;;
CREATE INDEX ix_chat_sessions_top_last_message ON chat_sessions (parent_session_id, last_message_at, id)
-- ;;
CREATE INDEX ix_chat_sessions_top_workspace_last_message ON chat_sessions (parent_session_id, workspace, last_message_at, id)
-- ;;
UPDATE alembic_version SET version_num='00000025' WHERE alembic_version.version_num = '00000024'
