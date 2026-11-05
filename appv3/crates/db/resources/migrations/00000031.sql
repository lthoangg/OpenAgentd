ALTER TABLE chat_sessions ADD COLUMN sent_from_session_id CHAR(32) REFERENCES chat_sessions (id) ON DELETE SET NULL
-- ;;
CREATE INDEX ix_chat_sessions_sent_from ON chat_sessions (sent_from_session_id) WHERE sent_from_session_id IS NOT NULL
-- ;;
UPDATE chat_sessions SET sent_from_session_id = (
	SELECT p.id FROM chat_sessions p WHERE p.id = (
		SELECT lower(replace(json_extract(m.extra, '$.sent_from.session_id'), '-', '')) FROM session_messages m
		WHERE m.session_id = chat_sessions.id AND m.role = 'user' AND m.kind IN ('chat', 'queued')
		ORDER BY m.seq ASC, m.id ASC LIMIT 1
	) AND p.id != chat_sessions.id
) WHERE parent_session_id IS NULL
-- ;;
UPDATE alembic_version SET version_num='00000031' WHERE alembic_version.version_num = '00000030'
