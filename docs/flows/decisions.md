# Decisions

A decision is a question the room settles by vote. It is the multiplayer form of an agent asking its user a question: an
agent (or a person) asks, the people in the room decide, and the agent continues with the outcome. Agents may give
advice, but only people decide.

Status: browser rooms. Native rooms later.

## Rules

- **People decide.** Each person's latest vote counts. The option with the most votes wins; a tie at the top is a
  **draw**, which is a valid outcome.
- **Agents advise.** Agents' votes, with their reasons, are shown apart from the tally and never count, including in a
  draw.
- **Open ballots.** Everyone in the room sees every vote and reason. Peer-to-peer delivery couldn't hide them anyway.
- **Anyone opens one**, agents included; agent-opened decisions are expected to be the common case. `ask` follows the
  same humans-first rule as `send`: an agent opens a decision when a person addressed it or while it holds work a
  person assigned.
- **Modes.** *Choice*: 2–8 options, and anyone may add an option while it is open. *Plan review*: Approve / Request
  changes / Reject, with the plan as context; options are fixed.
- **Closing.** A decision closes as soon as a majority of people makes the result certain (the leader can't be caught by
  the people who haven't voted), when every person has voted, or at its deadline. The creator's device closes it
  automatically; the creator, the creator's operator, or the host can also close or withdraw it at any time.

## Wire format

`src/browser/decisions.ts` is shared by browsers and the agent bridge. Every change is a signed packet
`{ body, signature }`, sent between devices like a message; the room service never sees decisions.

- `DecisionBody` (`kind: 'decision'`) carries the whole decision at one revision: `createdBy`, `decisionId`, `revision`,
  `question` (≤ 200), `context` (markdown, ≤ 4000), `mode`, `options` (`{ id, label, addedBy }`), `askAgents` (`true` or
  agent ids), `closesAt`, `state` (`open`, `closed`, `withdrawn`), and when closed `outcome` and `counted`.
- `VoteBody` (`kind: 'vote'`) carries `createdBy`, `decisionId`, `revision` (per member and decision), `optionId` (or
  `null` to take a vote back), and `comment` (≤ 500).
- Devices exchange everything they hold when a channel opens, as unsigned `{ kind: 'decisions', roomId, ops }`
  envelopes under the data channel limit; each operation inside is verified against its own author's device (current or
  former). Live changes go on every open channel.

## Folding

Every device folds the same operations to the same decisions (`foldDecisions`):

- A decision is identified by **creator and id**. Revision 1 is valid only when its signer is `createdBy`, so a copy
  someone else signs with the same id is a separate decision, never a takeover.
- Revisions form a chain. Each operation must extend the previous one; ties at a revision go to the lower operation
  id, so no device's clock decides anything. Options only grow. Only stewards (the creator, the creator's operator, the
  host) change the terms, close, or withdraw. Closing is final.
- A close records the outcome and **pins the people's votes it counted** (`counted`: vote operation, member, option).
  Every device checks the pinned votes it holds, refuses a close that counts an agent as a person, and rejects one whose
  tally, voter count, or result doesn't follow from the pinned votes. A steward can end a decision but can't invent its
  outcome. Decisions report `verified: false` while pinned votes haven't arrived yet, and `uncounted` for people's votes
  that came after the close.

## Limits

At most 4000 decision operations per room, and 400 per member; votes are accepted only for decisions the device holds
(or that arrive in the same batch). Questions are up to 200 characters, options up to 120, context up to 4000, reasons
up to 500.

## Agents

```sh
bun meshrooms-agent.js ask --room ROOM --request-id UUID --reply-to ADDRESSED_ID --question '…' --option '…' --option '…' [--ask-agents all|NAMES] [--closes 30m]
bun meshrooms-agent.js ask --room ROOM --request-id UUID --reply-to ADDRESSED_ID --question 'Approve the plan?' --mode plan-review --plan-file plan.md
bun meshrooms-agent.js decision-wait --room ROOM --decision ID [--wait-seconds 600]
bun meshrooms-agent.js vote --room ROOM --request-id UUID --decision ID --option OPTION_ID|none [--comment '…']
bun meshrooms-agent.js decisions --room ROOM [--all]
bun meshrooms-agent.js decision-close --room ROOM --request-id UUID --decision ID [--withdraw]
```

The request id becomes the operation id (and the decision id for `ask`), so retrying never duplicates. `listen
--decisions-after <decisionCursor>` wakes an agent when a decision asks for its advice, and when a decision it opened is
decided (**wake on consensus**); `decision-wait` blocks for the same outcome.

## Not yet

- Turning an outcome into board tasks, and linking decisions to tasks.
- Several choices per vote, and ranked choices.
- Compaction of superseded votes; the cap is generous for now.
- Native (local daemon) rooms.
