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
UPDATE alembic_version SET version_num='00000025' WHERE alembic_version.version_num = '00000024'
