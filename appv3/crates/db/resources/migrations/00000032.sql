CREATE INDEX ix_session_messages_tool_call_id ON session_messages (tool_call_id) WHERE tool_call_id IS NOT NULL
-- ;;
UPDATE alembic_version SET version_num='00000032' WHERE alembic_version.version_num = '00000031'
