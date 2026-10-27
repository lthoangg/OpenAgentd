CREATE TABLE inflight_turns (
	session_id CHAR(32) NOT NULL,
	started_at DATETIME NOT NULL,
	restart_resumes INTEGER DEFAULT 0 NOT NULL,
	PRIMARY KEY (session_id)
)
-- ;;
UPDATE alembic_version SET version_num='00000029' WHERE alembic_version.version_num = '00000028'
