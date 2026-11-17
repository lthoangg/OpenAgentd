// A plan review: comments on the plan go to the chat box with Reply in chat
// and are sent as a normal message with a Plan comments card; a resubmitted
// plan is approved with Keep going.
// Feature notes: ../../features/plan-review.md

export default async function planReview({ page, expect, step, newSessionInDemo, send, run, api, history, sessionId, modelRequests, phone }) {
  const passage = `Write the migration ${run}`
  const planArgs = (rev) => JSON.stringify({
    action: "write",
    content: `# Ship it ${run}\n\n**Outcome:** the endpoint ships (${rev}).\n\n1. ${passage}\n2. Wire the endpoint\n\n**Done when:** the endpoint answers ${run}.`,
    submit: true,
  })
  const review = page.getByText("Needs you · a plan to review").first()
  // The plan's line, not the prompt that carried it.
  const planLine = page.getByText(passage, { exact: true })
  const replyButton = (label) => page.getByRole("button", { name: label, exact: true })
  // The phone opens the plan from the bar pinned over the composer; the desktop dock opens it by itself.
  const openPlan = async () => {
    if (phone) await page.getByRole("button", { name: "View plan" }).click()
    await expect(replyButton("Reply in chat")).toBeVisible()
  }

  await step("start a new session in demo", async () => {
    await newSessionInDemo()
  })

  await step("the agent submits a plan and the review opens with no feedback box", async () => {
    await send(`drive:plan ${planArgs("first")}`)
    await expect(review).toBeVisible()
    await openPlan()
    await expect(planLine).toBeVisible()
    await expect(page.getByLabel("Feedback on the plan")).toHaveCount(0)
    await expect(page.getByText("Select plan text to comment, or reply in chat")).toBeVisible()
  })

  await step("the user comments on a passage", async () => {
    await planLine.selectText()
    await page.getByRole("button", { name: "Comment on selection" }).click()
    await page.getByLabel("Comment", { exact: true }).fill(`Make it reversible ${run}`)
    await page.getByRole("button", { name: "Add comment" }).click()
    await expect(page.getByRole("list", { name: "Comments on the plan" })).toContainText(`Make it reversible ${run}`)
    await expect(replyButton("Reply in chat (1)")).toBeVisible()
    await expect(page.getByRole("button", { name: /^Approve/ })).toBeDisabled()
  })

  await step("Reply in chat moves the comment into the chat box", async () => {
    await replyButton("Reply in chat (1)").click()
    await expect(page.getByText("Plan comments · 1 comment")).toBeVisible()
    await expect(page.getByRole("textbox", { name: "Message input" })).toBeFocused()
    if (phone) {
      // The sheet closed on the chat; the plan waits behind the pinned bar.
      await expect(page.getByRole("button", { name: "View plan" })).toBeVisible()
    } else {
      await expect(page.getByRole("list", { name: "Comments on the plan" })).toHaveCount(0)
      await expect(page.getByText("Send or remove your plan comments first")).toBeVisible()
      await expect(page.getByRole("button", { name: /^Approve/ })).toBeDisabled()
    }
  })

  await step("the user sends it as a normal message with a Plan comments card", async () => {
    await page.getByRole("textbox", { name: "Message input" }).fill(`Also keep the old path ${run}`)
    // The turn waits on the review, so Send reads "Steer the running turn".
    await page.getByRole("button", { name: "Steer the running turn" }).click()
    const card = page.getByRole("region", { name: "Plan comments · 1 comment" })
    await expect(card).toBeVisible()
    await expect(card).toContainText(passage)
    await expect(card).toContainText(`Make it reversible ${run}`)
    await expect(page.getByText(`Also keep the old path ${run}`, { exact: true })).toBeVisible()
    await expect(page.getByText(/^Stub reply \(chat\): Also keep the old path/)).toBeVisible()
    // The chip left the chat box with the message, and the review closed.
    await expect(page.getByText("Plan comments · 1 comment")).toHaveCount(1)
    await expect(review).toHaveCount(0)
    // The server stored the message with the block, and the model read it after the superseded review.
    const lead = await history(sessionId())
    const user = lead.messages.filter((m) => m.role === "user").pop()
    expect(user.content).toContain(`<plan-comments path=".agents/plans/`)
    expect(user.content).toContain(`Make it reversible ${run}`)
    const sent = JSON.stringify(modelRequests().filter((r) => r.stream).pop().request)
    expect(sent).toContain("Superseded")
    expect(sent).toContain(`> ${passage}`)
  })

  await step("the card stays after a reload", async () => {
    await page.reload({ waitUntil: "load" })
    await expect(page.getByRole("region", { name: "Plan comments · 1 comment" })).toContainText(`Make it reversible ${run}`)
  })

  await step("a resubmitted plan is approved with Keep going", async () => {
    await send(`drive:plan ${planArgs("second")}`)
    await expect(review).toBeVisible()
    await openPlan()
    const toggle = phone
      ? page.getByRole("button", { name: "Keep going until done" })
      : page.getByRole("checkbox", { name: "Keep going until done" })
    await expect(toggle).toBeEnabled()
    if (!(phone ? (await toggle.getAttribute("aria-pressed")) === "true" : await toggle.isChecked())) await toggle.click()
    await page.getByLabel("Turns for this goal").fill("1")
    await page.getByRole("button", { name: "Approve and keep going (1 turn)" }).click()
    await expect(review).toHaveCount(0)
    const { goal } = await api("GET", `/agent/sessions/${sessionId()}/goal`)
    expect(goal?.max_turns).toBe(1)
    expect(goal?.objective).toContain(`the endpoint answers ${run}`)
  })
}
