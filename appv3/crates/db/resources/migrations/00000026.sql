UPDATE chat_sessions SET scheduled_task_name = NULL WHERE scheduled_task_name IS NOT NULL AND substr(id, 13, 1) != '5'
-- ;;
UPDATE alembic_version SET version_num='00000026' WHERE alembic_version.version_num = '00000025'
