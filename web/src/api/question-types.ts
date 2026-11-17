// Questions the lead pauses on (ask_user, plan review, secret request) and
// the secrets behind a secret request: the shapes of `/agent/{sid}/question`
// and `/api/secrets`. Values never appear here, only names and projects.

// ── ask_user ────────────────────────────────────────────────────────

export interface QuestionOption {
  label: string
  description?: string | null
  /** The agent's preferred choice. Renders a "Recommended" badge. */
  recommended: boolean
}

export interface QuestionItem {
  question: string
  /** Very short label (<=30 chars) for the stepper tab. */
  header: string
  options: QuestionOption[]
  multiple: boolean
}

/** Wire shape of a `pending_questions` row (history + `GET /{sid}/question`). */
export interface PendingQuestionResponse {
  id: string
  session_id: string
  tool_call_id: string
  questions: QuestionItem[]
  created_at: string
  /** ``plan_review`` for a plan review (``plan`` with ``submit: true``); absent for ``ask_user``. */
  kind?: string | null
  plan_revision?: number | null
  /** A secret request's card (``kind: 'secret_request'``): names and states, never values. */
  secret?: SecretRequestCard | null
}

export interface PendingQuestionEnvelope {
  question: PendingQuestionResponse | null
}

/** A question the lead is suspended on, awaiting the user's reply. */
export interface PendingQuestion {
  id: string
  sessionId: string
  toolCallId: string
  questions: QuestionItem[]
  /** ``plan_review`` when the lead waits on a plan review (``plan`` with ``submit: true``). */
  kind?: 'plan_review' | 'secret_request'
  /** The plan revision the review was opened for. */
  planRevision?: number
  /** The secret card's data, when ``kind`` is ``secret_request``. */
  secret?: SecretRequestCard
}

// ── secrets ─────────────────────────────────────────────────────────

/** A project as the server names it: its key (a folder path), folder name, and whether the folder is gone. */
export interface SecretProject {
  key: string
  name: string
  missing?: boolean
}

/** One saved value of a secret, without the value. */
export interface SecretValueRef {
  id: string
  /** Used by every project. */
  all: boolean
  projects: SecretProject[]
  updated?: string
}

/**
 * One key on a secret card. ``new``: never saved, paste it. ``elsewhere``:
 * saved for other projects only (``values``), reuse one or paste another.
 * ``replace``: usable here, but rejected; ``values[0]`` is the one in use.
 * ``available``: usable here already (not shown).
 */
export interface SecretRequestKey {
  name: string
  help_url?: string | null
  optional: boolean
  multiline: boolean
  state: 'new' | 'elsewhere' | 'replace' | 'available'
  values: SecretValueRef[]
}

/** ``payload.secret`` of a ``secret_request`` question. */
export interface SecretRequestCard {
  /** The project key new values are saved for. */
  project: string
  project_name: string
  reason: string
  replace: boolean
  keys: SecretRequestKey[]
}

/** How the user answered one key: its value went to ``PUT /api/secrets`` (``provided``), a saved one (``reuse``), or none. */
export interface SecretKeyAnswer {
  name: string
  action: 'provided' | 'reuse' | 'skip'
  id?: string
}

export interface SecretAnswer {
  declined?: boolean
  reason?: string
  keys?: SecretKeyAnswer[]
}

/** A row of ``GET /api/secrets``: one saved value, never the value itself. */
export interface SecretEntry extends SecretValueRef {
  name: string
  source?: string
}

export interface SecretsListResponse {
  secrets: SecretEntry[]
  /** With ``?workspace=``: that folder's project, and the names it can use. */
  project?: SecretProject
  usable?: string[]
}

export interface QuestionResolveResult {
  status: string
  /** False when the answer was saved but the turn could not be restarted. */
  resumed: boolean
}
