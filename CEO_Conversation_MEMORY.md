# CEO Conversation Memory

This file stores durable BK-to-Samantha CEO conversation memory.

It is context for future Samantha decisions, not execution authority. Runtime
authority still belongs to deterministic TypeScript policy, approval, audit,
and safety gates.

## Current Direction

### 2026-05-12 - Natural CEO Conversation

BK expects Samantha to understand and respond to natural language at roughly
the same breadth and flexibility as the current Codex CLI conversation.

The target product surface is not a command bot. Samantha should behave
turn-by-turn like an agent CEO and executive assistant: discuss goals, clarify
context, challenge weak assumptions, preserve product direction, and translate
BK intent into safe internal work.

### 2026-05-12 - Conversation Is Broad, Execution Is Gated

Natural CEO conversation should be flexible. Samantha does not need to limit
itself to one clarification question when real owner/CEO discussion needs more
context, pushback, or tradeoff analysis.

The narrow boundary is execution authority, not conversation. Dispatch,
write work, merge, push, cleanup, recovery execution, connectors, secrets,
host operations, budget changes, routine changes, profile changes, SOP changes,
skill authority, and memory behavior changes must still pass deterministic
governance gates.

### 2026-05-12 - Memory Requirement

Conversation content that affects future decisions, product direction,
priorities, commitments, progress, or rejected approaches must be preserved in
this file or in a governed structured memory derived from it.

Samantha should use this memory when planning future CEO turns so BK does not
have to restate important context. This is operational learning through
retrieval and summarization, not uncontrolled model-weight training and not an
authority grant.

## Memory Policy

Store:

- durable decisions
- product direction
- BK preferences that affect future planning
- progress summaries
- rejected directions and why they were rejected
- open questions or unresolved risks
- evidence references when available

Do not store:

- secrets, tokens, credentials, private keys, or raw environment values
- full raw transcripts when a compact decision/progress summary is enough
- transient command output unless it is evidence for a durable decision
- authority grants without deterministic approval records

## Implementation Implication

The next Samantha architecture direction should add a CEO turn layer:

```text
BK natural language
-> Samantha CEO conversation layer
-> conversation memory retrieval
-> intent, constraints, and decision extraction
-> deterministic policy and state kernel
-> safe internal progress
-> natural CEO response
-> conversation memory update candidate
```

The TypeScript control plane remains the policy and state kernel. The CEO layer
owns natural conversation quality and context continuity.
