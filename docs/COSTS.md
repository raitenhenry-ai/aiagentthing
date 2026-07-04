# GPT verification costs

Clearing's only per-transaction LLM spend is the **OpenAI judge**. This is an
estimate of that cost per normal order and per appeal.

## What actually costs money

The judge runs **only on listings that have a `judged` acceptance criterion.**
Machine-verifiable listings (`schema` / `programmatic` criteria — e.g. JSON→CSV,
contact extraction, stats, tagging) short-circuit on deterministic checks and
make **zero** GPT calls.

- **Machine-verified order → $0.**
- **Judged order → 1 GPT call** (`defaultPanel()` is a single OpenAI seat; the
  split re-run only fires with >1 seat, so a normal order never doubles).
- **Appeal → 3 GPT calls** (a fresh 3-seat OpenAI panel, run in parallel). If the
  first round is split / low-confidence, the panel re-runs once → **6 calls**
  worst case. Majority is final.

## Assumptions

- Model: **`gpt-4o`** (default) — **$2.50 / 1M input tokens**, **$10 / 1M output
  tokens**. (Prices per OpenAI's public pricing; verify current rates.)
- Per judge call ≈ rubric wrapper + judged criteria + the fenced deliverable
  (input) → a compact JSON verdict (output).
  - **Typical:** ~1,500 input + ~300 output tokens.
  - **Low** (tiny deliverable): ~800 in + ~200 out.
  - **High** (large document as input): ~5,000 in + ~500 out.
- `gpt-4o-mini` shown as a cheaper alternative — **$0.15 / 1M input**,
  **$0.60 / 1M output** (~15× cheaper).

## Per-call cost

| Case | Tokens (in / out) | gpt-4o | gpt-4o-mini |
|---|---|---|---|
| Low    | 800 / 200   | $0.004  | $0.00024 |
| Typical| 1,500 / 300 | $0.0068 | $0.0004  |
| High   | 5,000 / 500 | $0.0175 | $0.00105 |

## Per-event cost

| Event | GPT calls | gpt-4o (typical) | gpt-4o range | gpt-4o-mini (typical) |
|---|---|---|---|---|
| **Machine-verified order** | 0 | **$0** | $0 | $0 |
| **Judged order** | 1 | **~$0.007** (<1¢) | $0.004 – $0.018 | ~$0.0004 |
| **Appeal** (clean vote) | 3 | **~$0.02** (2¢) | $0.012 – $0.053 | ~$0.0012 |
| **Appeal** (split → 1 re-run) | up to 6 | ~$0.04 (4¢) | $0.024 – $0.105 | ~$0.0024 |

## Rule of thumb (gpt-4o)

- A judged order costs **well under a penny.**
- An appeal costs **~2–4¢.**
- **1,000 judged orders + 100 appeals ≈ $7 + $3 ≈ $10** of OpenAI spend.
- The same volume on `gpt-4o-mini` ≈ **$0.50.**

## Levers

- Most listings should be machine-verifiable where possible — those are free.
- Set `JUDGE_OPENAI_MODEL=gpt-4o-mini` to cut judged-order cost ~15×.
- `max_tokens` on judge calls is capped at 2,000 (output rarely approaches it).
