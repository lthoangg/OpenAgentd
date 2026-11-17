UPDATE pending_questions SET status = 'dismissed' WHERE status NOT IN ('pending', 'answered', 'dismissed', 'superseded', 'expired')
-- ;;
UPDATE side_questions SET status = 'stopped' WHERE status NOT IN ('streaming', 'done', 'error', 'stopped')
-- ;;
UPDATE session_goals SET status = 'cleared', ended_at = COALESCE(ended_at, updated_at) WHERE status NOT IN ('active', 'paused', 'achieved', 'cleared')
-- ;;
UPDATE scheduled_task SET status = 'paused', enabled = 0 WHERE status NOT IN ('pending', 'running', 'paused', 'completed', 'failed')
-- ;;
CREATE TRIGGER ck_pending_questions_status_insert BEFORE INSERT ON pending_questions WHEN NEW.status NOT IN ('pending', 'answered', 'dismissed', 'superseded', 'expired') BEGIN SELECT RAISE(ABORT, 'pending_questions.status must be pending, answered, dismissed, superseded or expired'); END
-- ;;
CREATE TRIGGER ck_pending_questions_status_update BEFORE UPDATE OF status ON pending_questions WHEN NEW.status NOT IN ('pending', 'answered', 'dismissed', 'superseded', 'expired') BEGIN SELECT RAISE(ABORT, 'pending_questions.status must be pending, answered, dismissed, superseded or expired'); END
-- ;;
CREATE TRIGGER ck_side_questions_status_insert BEFORE INSERT ON side_questions WHEN NEW.status NOT IN ('streaming', 'done', 'error', 'stopped') BEGIN SELECT RAISE(ABORT, 'side_questions.status must be streaming, done, error or stopped'); END
-- ;;
CREATE TRIGGER ck_side_questions_status_update BEFORE UPDATE OF status ON side_questions WHEN NEW.status NOT IN ('streaming', 'done', 'error', 'stopped') BEGIN SELECT RAISE(ABORT, 'side_questions.status must be streaming, done, error or stopped'); END
-- ;;
CREATE TRIGGER ck_session_goals_status_insert BEFORE INSERT ON session_goals WHEN NEW.status NOT IN ('active', 'paused', 'achieved', 'cleared') BEGIN SELECT RAISE(ABORT, 'session_goals.status must be active, paused, achieved or cleared'); END
-- ;;
CREATE TRIGGER ck_session_goals_status_update BEFORE UPDATE OF status ON session_goals WHEN NEW.status NOT IN ('active', 'paused', 'achieved', 'cleared') BEGIN SELECT RAISE(ABORT, 'session_goals.status must be active, paused, achieved or cleared'); END
-- ;;
CREATE TRIGGER ck_scheduled_task_status_insert BEFORE INSERT ON scheduled_task WHEN NEW.status NOT IN ('pending', 'running', 'paused', 'completed', 'failed') BEGIN SELECT RAISE(ABORT, 'scheduled_task.status must be pending, running, paused, completed or failed'); END
-- ;;
CREATE TRIGGER ck_scheduled_task_status_update BEFORE UPDATE OF status ON scheduled_task WHEN NEW.status NOT IN ('pending', 'running', 'paused', 'completed', 'failed') BEGIN SELECT RAISE(ABORT, 'scheduled_task.status must be pending, running, paused, completed or failed'); END
-- ;;
UPDATE alembic_version SET version_num='00000034' WHERE alembic_version.version_num = '00000033'
