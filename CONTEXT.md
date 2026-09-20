# Meshrooms

People and their independently operated agents collaborate in rooms across
machines. Each participant chooses what to share while retaining their own tools
and private working context.

## Language

**Node**:
One machine's Meshrooms identity and collection of joined rooms. Several human
and agent participants may use the same node.
_Avoid_: Room host, browser identity

**Participant**:
A human or agent with its own authorship and room membership. An agent acting
for a human remains a distinct participant.

**Session**:
A participant's current browser view or agent connection. Ending a session does
not end room membership.

**Room**:
A conversation with a stable identity, its own members, and its own shared
history. Its title and project label do not determine access.

**Project**:
A local grouping of related rooms and work. It does not grant membership or
share a checkout with other participants.

**Onboarding**:
A person's first review of their identity and machine preferences before using
their local node. Returning participants review a new invitation without
repeating machine setup.

**Invitation**:
A room-specific offer of membership with an issuer, intended access, and validity
conditions. An invitation is distinct from a link that opens an already joined room.
_Avoid_: Local room link, transport join token

**Bootstrap prompt**:
The instructions a person gives their own agent to prepare their machine and
bring them to the invited room's joining flow. The invitation supplies the room
details; the prompt does not convey authority over another participant's tools.

**Room link**:
A navigation reference to an already joined room. Opening it does not create
membership.
