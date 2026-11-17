CREATE INDEX ix_session_messages_reply_requests ON session_messages (session_id, seq, id) WHERE json_extract(extra, '$.sent_from.reply') = 1
-- ;;
UPDATE alembic_version SET version_num='00000033' WHERE alembic_version.version_num = '00000032'
