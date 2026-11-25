// Fill the perf sandbox through its API, the way the app writes sessions:
// SESSIONS short sessions and two long ones (`Long session…` for the open
// cases, `Work session…` for the interaction scenario) whose last turn holds MARKER.
//   API=http://127.0.0.1:8794/api WORKSPACE=/tmp/oad-perf-drive/code/demo bun scripts/perf/browser_seed.mjs
// Prints `SEEDED long=<id> work=<id>`. A long session is TURNS turns: the
// first 80 are a prompt with a Markdown answer every fourth turn and a
// 40-line shell call otherwise; the rest carry five Markdown sections each
// (lists, code, a table), every third a shell call. The stub must echo whole
// prompts (`--reply-chars 20000`) for the answers to be that long.
const API = process.env.API
const WORKSPACE = process.env.WORKSPACE
const SESSIONS = Number(process.env.SESSIONS ?? 300)
const TURNS = Number(process.env.TURNS ?? 104)
export const MARKER = "zebra-quartz-marker"

async function chat(fields) {
  const form = new FormData()
  for (const [k, v] of Object.entries({ workspace: WORKSPACE, interaction_mode: "code", ...fields })) form.set(k, v)
  const res = await fetch(`${API}/agent/chat`, { method: "POST", body: form })
  const text = await res.text()
  if (!res.ok) throw new Error(`chat answered ${res.status}: ${text.slice(0, 300)}`)
  return JSON.parse(text).session_id
}

async function idle(id) {
  for (let i = 0; i < 2400; i++) {
    const history = await (await fetch(`${API}/agent/${id}/history`)).json()
    if (!history.lead.running) return history
    await Bun.sleep(50)
  }
  throw new Error(`session ${id} is still running`)
}

const section = (name) => [
  `${name}: what changed in the billing module.`,
  "",
  "- rounding happens once, at the invoice level",
  "- tax lines keep **four** decimals until the total",
  "- see `billing/tests.rs` and [the notes](https://example.test/notes)",
  "",
  "```rust",
  "fn round_invoice(x: f64) -> f64 {",
  `    // ${name}`,
  "    (x * 100.0).round() / 100.0",
  "}",
  "```",
  "",
  "| line | before | after |",
  "|---|---|---|",
  "| tax | 1.2345 | 1.23 |",
  "| total | 10.005 | 10.01 |",
  "",
  "The remaining edge cases are covered by the tests above, and nothing else in the module reads the old field.",
].join("\n")
const shell = (name) => `drive:shell for n in $(seq 1 40); do echo "line $n of ${name}: cargo test billing::rounding ... ok"; done`

/** A TURNS-turn session titled after `title`, ending with the marker turn. */
async function seedLong(title) {
  const id = await chat({ message: `${title}: refactor billing\n\n${section("Step 0")}` })
  await idle(id)
  for (let i = 1; i < TURNS; i++) {
    let message
    if (i === TURNS - 1) message = `Final turn ${MARKER}\n\n${section("Final")}`
    else if (i < 80) message = i % 4 === 0 ? section(`Step ${i}`) : shell(`step ${i}`)
    else message = i % 3 === 2 ? shell(`rich ${i}`) : Array.from({ length: 5 }, (_, k) => section(`Rich ${i}.${k}`)).join("\n\n")
    await chat({ message, session_id: id })
    await idle(id)
  }
  const history = await idle(id)
  const last = history.lead.messages.at(-1)
  if (last.role !== "assistant" || !(last.content ?? "").includes(MARKER)) throw new Error(`${title} does not end with the marker answer`)
  console.error(`seeded "${title}": ${TURNS} turns (newest page: ${history.lead.messages.length} rows, more: ${history.has_more})`)
  return id
}

if (import.meta.main) {
  if (!API || !WORKSPACE) throw new Error("browser_seed: set API and WORKSPACE")
  const short = (i) => chat({ message: `Short session ${i}: tidy the ${["parser", "router", "store", "tests", "docs"][i % 5]}` })
  // One message first: it registers the folder, and messages sent at once
  // into a folder the server has not seen race to do that (some answer 500).
  await idle(await short(0))
  let next = 1
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < SESSIONS) {
      await idle(await short(next++))
    }
  }))
  const long = await seedLong("Long session")
  // The interaction scenario writes to a session of its own, so the one the
  // open cases read stays the same from run to run.
  const work = await seedLong("Work session")
  console.log(`SEEDED long=${long} work=${work}`)
}
