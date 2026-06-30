#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

usage() {
    cat <<'EOF'
Usage: scripts/release_commits_since_last_tag.sh [--stat] [<base-tag>]

Show commits since the latest release tag (or a provided base tag) to help
prepare the next release.

Options:
  --stat     include per-commit changed-file stats
  -h, --help show this help

Examples:
  scripts/release_commits_since_last_tag.sh
  scripts/release_commits_since_last_tag.sh --stat
  scripts/release_commits_since_last_tag.sh v1.88.0
EOF
}

show_stat=0
base_tag=

while [ $# -gt 0 ]; do
    case "$1" in
        --stat)
            show_stat=1
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        --)
            shift
            break
            ;;
        -*)
            echo "error: unknown option: $1" >&2
            usage >&2
            exit 2
            ;;
        *)
            if [ -n "$base_tag" ]; then
                echo "error: expected at most one base tag argument" >&2
                usage >&2
                exit 2
            fi
            base_tag=$1
            ;;
    esac
    shift
done

if [ $# -gt 0 ]; then
    echo "error: unexpected extra arguments" >&2
    usage >&2
    exit 2
fi

if [ -z "$base_tag" ]; then
    base_tag=$(git describe --tags --abbrev=0)
fi

if ! git rev-parse --verify "$base_tag^{tag}" >/dev/null 2>&1; then
    echo "error: tag not found: $base_tag" >&2
    exit 2
fi

head_ref=$(git rev-parse --short HEAD)
commit_count=$(git rev-list --count "$base_tag"..HEAD)

printf 'Base tag: %s\n' "$base_tag"
printf 'Head: %s\n' "$head_ref"
printf 'Commits since base: %s\n' "$commit_count"
printf '\n'

if [ "$commit_count" -eq 0 ]; then
    echo "No commits since $base_tag"
    exit 0
fi

git log "$base_tag"..HEAD --no-merges --date=short \
    --format='- %h %ad %s'

if [ "$show_stat" -eq 1 ]; then
    printf '\nDetailed stats:\n\n'
    git log "$base_tag"..HEAD --no-merges --format='%H' |
    while IFS= read -r commit; do
        [ -n "$commit" ] || continue
        git show --stat --summary --format='commit %h%nAuthor: %an%nDate:   %ad%n%n    %s%n' --date=short "$commit"
        printf '\n'
    done
fi
