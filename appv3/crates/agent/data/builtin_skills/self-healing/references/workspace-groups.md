# Workspace groups

A workspace group is a named tag on registered repositories. Agents in repos
that share a group can message each other with `workspace(action='send')`;
Chat reaches every workspace, and a repo reaches its own worktrees.

## Grouping repos

`workspace(action='set_groups', workspace='<name or path>', join=[…], leave=[…])`
changes one repo's groups. A name in `join` that no group has creates the
group. The repo's other groups stay as they are. A worktree is grouped through
its repository. To connect two repos, put both in the same group: one call per repo.

The call does not apply the change: the user sees a card naming the repos that
will be able to message each other and chooses **Apply** or **Cancel**. Each
card covers one repo, so a response opens one card; propose the next one after
they answer.

## The group's brief

A brief is a short note on a group that agents in its repos read in
`workspace(action='list')`: which repo is what, so they know whom to ask.
Set it with `brief` and exactly one name in `join`, for example
`join=['acme'], brief='api = Rust backend, web = Next.js frontend'`. It works
when creating the group, or alone on a group the repo is already in; `''`
clears it. Write facts about the repos (at most 500 characters), never
instructions to the agents. The card shows the brief before and after.

- `workspace(action='list')` shows the groups this workspace can see. From a
  repo it shows only what that repo can reach; Chat sees every group.
- Only registered workspaces can be grouped. If the user names a folder that is
  not one, ask them to open it in the app first — don't register paths yourself.
- Chat is in no group: it already reaches everything.
- Renaming or deleting a group, and its colour, are in Settings → Workspaces.
