CREATE TABLE session_goals (
	session_id CHAR(32) NOT NULL,
	id CHAR(32) NOT NULL,
	objective TEXT NOT NULL,
	status VARCHAR(16) NOT NULL,
	pause_reason VARCHAR(32),
	detail TEXT,
	max_turns INTEGER NOT NULL,
	token_budget INTEGER,
	turns_used INTEGER DEFAULT 0 NOT NULL,
	tokens_used INTEGER DEFAULT 0 NOT NULL,
	active_seconds INTEGER DEFAULT 0 NOT NULL,
	rejected_claims INTEGER DEFAULT 0 NOT NULL,
	idle_turns INTEGER DEFAULT 0 NOT NULL,
	created_at DATETIME NOT NULL,
	updated_at DATETIME NOT NULL,
	ended_at DATETIME,
	PRIMARY KEY (session_id, id)
) WITHOUT ROWID
-- ;;
CREATE UNIQUE INDEX uq_session_goals_live ON session_goals (session_id) WHERE status IN ('active', 'paused')
-- ;;
UPDATE alembic_version SET version_num='00000028' WHERE alembic_version.version_num = '00000027'
