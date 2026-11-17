// A repository's worktree list follows git and the disk: a worktree removed
// outside the app drops off on the next load while its session stays under
// the repository, and one made with plain git is listed as external.
// Feature notes: ../../features/worktrees.md
import { execFileSync } from "node:child_process"

export default async function worktrees({ page, expect, step, api, seedSession, open, phone, run, demo }) {
  const git = (...args) => execFileSync("git", ["-C", demo, ...args], { encoding: "utf8" })
  const prompt = `Work in the doomed worktree ${run}`
  // Preconditions: two OpenAgentd worktrees, one with a session; one made
  // with plain git; then the first removed behind the app's back.
  const doomed = await api("POST", "/agent/workspace/worktrees", { source_workspace: demo, name: `doomed-${run}` })
  const kept = await api("POST", "/agent/workspace/worktrees", { source_workspace: demo, name: `kept-${run}` })
  await seedSession(prompt, { workspace: doomed.directory })
  const external = `${demo}-ext-${run}`
  git("worktree", "add", "-q", "-b", `ext-${run}`, external)
  git("worktree", "remove", "--force", doomed.directory)

  const list = page.getByRole("complementary").first()
  /** The demo row's checkout menu: a menu on desktop, a sheet on a phone. */
  const openCheckouts = async () => {
    await list.getByRole("button", { name: /^\d+ (worktrees?|folders?)/ }).first().click()
    return phone ? page.getByRole("dialog", { name: "Worktrees for demo" }) : page.getByRole("menu", { name: "Worktrees for demo" })
  }

  await step("the removed worktree is gone from demo's checkouts; the others are listed", async () => {
    await open("/")
    const expand = list.getByRole("button", { name: "Expand workspace demo" })
    await expand.or(list.getByRole("button", { name: "Collapse workspace demo" })).first().waitFor()
    if (await expand.isVisible()) await expand.click()
    const menu = await openCheckouts()
    await expect(menu.getByText(`kept-${run}`, { exact: true })).toBeVisible()
    await expect(menu.getByText(`demo-ext-${run}`, { exact: true })).toBeVisible()
    await expect(menu.getByText(`doomed-${run}`, { exact: true })).toHaveCount(0)
  })

  await step("the worktree made with plain git is marked external", async () => {
    const menu = phone ? page.getByRole("dialog", { name: "Worktrees for demo" }) : page.getByRole("menu", { name: "Worktrees for demo" })
    if (phone) {
      await expect(menu.getByRole("radio", { name: new RegExp(`^demo-ext-${run} External worktree`) })).toBeVisible()
    } else {
      await expect(menu.getByRole("menuitemradio", { name: new RegExp(`^demo-ext-${run} external$`) })).toBeVisible()
    }
    await page.keyboard.press("Escape")
    await expect(menu).toHaveCount(0)
  })

  await step("the session from the removed worktree stays under demo", async () => {
    // Its title is cut to fit; the tag names the worktree it ran in.
    await expect(list.getByRole("button", { name: new RegExp(`^Work in the doomed worktree .*, in worktree doomed-${run}$`) })).toBeVisible()
    // The server agrees: no row for it, and its sessions are kept with demo.
    const tree = await api("GET", "/agent/workspace/tree")
    // The server stores resolved paths (/tmp is /private/tmp on macOS).
    const repo = tree.repositories.find((r) => r.path.endsWith("/code/demo"))
    const gone = (p) => p.endsWith(`/doomed-${run}`)
    expect(repo.worktrees.filter((w) => gone(w.path))).toEqual([])
    expect(repo.worktrees.find((w) => w.path === kept.directory)?.external).toBe(false)
    expect(repo.worktrees.find((w) => w.path.endsWith(`demo-ext-${run}`))?.external).toBe(true)
    expect(repo.former_checkouts.filter((w) => gone(w.path)).length).toBe(1)
  })
}
