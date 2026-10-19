CREATE INDEX IF NOT EXISTS ix_session_messages_usage ON session_messages (session_id, kind, json_extract(extra, '$.usage.cost.estimated_usd'), json_extract(extra, '$.usage.output'))
-- ;;
CREATE INDEX IF NOT EXISTS ix_session_messages_queued ON session_messages (session_id, seq, id) WHERE kind = 'queued'
-- ;;
CREATE TABLE side_questions (
	session_id CHAR(32) NOT NULL,
	id CHAR(32) NOT NULL,
	question TEXT NOT NULL,
	answer TEXT DEFAULT '' NOT NULL,
	status VARCHAR(16) NOT NULL,
	error TEXT,
	model VARCHAR(200),
	usage JSON,
	created_at DATETIME NOT NULL,
	updated_at DATETIME NOT NULL,
	PRIMARY KEY (session_id, id)
) WITHOUT ROWID
-- ;;
UPDATE alembic_version SET version_num='00000023' WHERE alembic_version.version_num = '00000022'
