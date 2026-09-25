import { Fragment, useEffect, useRef, useState, type FormEvent } from 'react';
import { mentionedIds } from '../collab';
import { MentionText, useMentions } from '../prototype/Collaboration';
import { Wordmark } from '../prototype/RoomPrototype';
import type { Participant } from '../room';
import { BrowserApi } from './client';
import { BrowserPeers, type SavedMessage } from './peers';
import { identity, read, write } from './storage';
import type { BrowserMember, JoinRequest, RoomStatus } from './protocol';
import './browser.css';

type RecentRoom = { id: string; title: string };
const deviceLabel = /Mac/.test(navigator.userAgent) ? 'Mac browser' : /Windows/.test(navigator.userAgent) ? 'Windows browser' : 'Browser';
const urlRoom = location.pathname.match(/^\/r\/([a-f0-9-]{36})$/)?.[1] || '';

function RoomIcon({ kind }: { kind: 'people' | 'link' | 'close' | 'chat' | 'send' }) {
  const paths = {
    people: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M21 21v-3a6 6 0 0 0-3-5" /></>,
    link: <><path d="m10 14 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    chat: <path d="M20 15a3 3 0 0 1-3 3H8l-5 3V6a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3Z" />,
    send: <path d="m4 12 8-8 8 8M12 4v16" />,
  };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}

const isAgent = (member: BrowserMember | undefined) => member?.role === 'agent';
/** Room members in the shape the shared mention helpers expect. Members from before agents existed are people. */
const participantsOf = (members: BrowserMember[] = []): Participant[] =>
  members.map(m => ({ id: m.id, name: m.name, role: m.role ?? 'human', state: 'remote', detail: '', operatorId: m.operatorId }));
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
const grouped = (a: SavedMessage | undefined, b: SavedMessage) => !!a && a.packet.body.memberId === b.packet.body.memberId && sameDay(a.packet.body.at, b.packet.body.at) && b.packet.body.at - a.packet.body.at < 300_000;
function dayLabel(at: number) {
  return sameDay(at, Date.now()) ? 'Today' : new Date(at).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
}

export function BrowserRooms() {
  const [api] = useState(() => new BrowserApi());
  const [status, setStatus] = useState<RoomStatus>();
  const [title, setTitle] = useState('');
  const [name, setName] = useState('');
  const [recent, setRecent] = useState<RecentRoom[]>([]);
  const [messages, setMessages] = useState<SavedMessage[]>([]);
  const [connected, setConnected] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [network, setNetwork] = useState('');
  const [notice, setNotice] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [unread, setUnread] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [liveMessage, setLiveMessage] = useState<{ id: string; text: string }>();
  const [replyId, setReplyId] = useState<string>();
  const [agentName, setAgentName] = useState('');
  const [agentLink, setAgentLink] = useState<{ name: string; url: string }>();
  const [confirming, setConfirming] = useState<string>();
  const composer = useRef<HTMLTextAreaElement>(null);
  const currentStatus = useRef<RoomStatus | undefined>(undefined);
  const lastRequest = useRef<JoinRequest | undefined>(undefined);
  const peers = useRef<BrowserPeers | null>(null);
  const everJoined = useRef(false);
  const transcript = useRef<HTMLElement>(null);
  const detailsHeading = useRef<HTMLHeadingElement>(null);
  const detailsButton = useRef<HTMLButtonElement>(null);
  const admitted = !!status?.memberId;
  const host = admitted && status?.memberId === status?.ownerId;
  const self = status?.members?.find(m => m.id === status.memberId);
  const pending = status?.request?.state === 'pending';
  const participants = participantsOf(status?.members);
  const mentions = useMentions(participants, status?.memberId, composer, setText);
  const agents = status?.members?.filter(isAgent) || [];
  const people = (status?.members?.length || 0) - agents.length;
  const reply = messages.find(m => m.packet.body.id === replyId);
  /** "you", or the operator's name, for an agent member. */
  const operatorOf = (member: BrowserMember | undefined) => {
    if (!isAgent(member) || !member!.operatorId) return undefined;
    return member!.operatorId === status?.memberId ? 'you' : status?.members?.find(m => m.id === member!.operatorId)?.name || 'a former member';
  };
  const nameOf = (memberId: string) => status?.members?.find(m => m.id === memberId)?.name || 'Former member';

  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout>, wake: (() => void) | undefined;
    let engine: BrowserPeers | undefined;
    setReady(false); setError('');
    void (async () => {
      const device = await identity();
      const rooms = await read<RecentRoom[]>('recent-rooms') || [];
      const profile = await read<string>('display-name') || '';
      if (disposed) return;
      setRecent(rooms); setName(profile);
      if (!urlRoom) {
        const pendingCreate = await read<{ name: string; title: string }>('pending-create');
        if (pendingCreate) { setName(pendingCreate.name); setTitle(pendingCreate.title); }
        setReady(true); return;
      }
      const response = await fetch(`/api/lobby/rooms/${urlRoom}`, { signal: AbortSignal.timeout(10_000) });
      const info = await response.json(); if (!response.ok) throw new Error(info.error || 'Room unavailable.');
      if (disposed) return;
      setTitle(info.title);
      await navigator.locks.request(`meshrooms-room:${urlRoom}`, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('This room is already open in another tab of this browser. Close that tab, then retry here.');
        if (disposed) return;
        const session = crypto.randomUUID(); let cursor = 0, epoch = '', recorded = false;
        engine = new BrowserPeers(api, urlRoom, device.id, session, (m, c, added) => {
          if (disposed) return;
          if (added) {
            const own = added.packet.body.deviceId === device.id;
            const scroller = transcript.current;
            const atBottom = !!scroller && scroller.clientHeight > 0 && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 100;
            const usingControls = !!document.activeElement?.closest('.browser-requests, .browser-details');
            if (own || (atBottom && !usingControls)) requestAnimationFrame(() => scrollToLatest());
            else setUnread(count => count + 1);
            if (!own) {
              const author = currentStatus.current?.members?.find(p => p.id === added.packet.body.memberId)?.name || 'Room member';
              setLiveMessage({ id: added.packet.body.id, text: `${author}: ${added.packet.body.text}` });
            }
          }
          setMessages(m); setConnected(c);
        }, message => { if (!disposed) setNetwork(message); });
        peers.current = engine; await engine.load();
        while (!disposed) {
          try {
            const next = await api.command('status', urlRoom, { session, cursor, epoch });
            if (disposed) break;
            if (next.epoch !== epoch) cursor = 0;
            epoch = next.epoch;
            if (!next.memberId && !next.request && lastRequest.current) {
              const prior = lastRequest.current;
              if (prior.state === 'expired' || prior.state === 'declined') next.request = prior;
              else if (prior.state === 'pending' && prior.expiresAt <= Date.now()) next.request = { ...prior, state: 'expired', code: undefined };
            }
            if (next.request?.state === 'expired' || next.request?.state === 'declined') setNotice('');
            lastRequest.current = next.request;
            currentStatus.current = next;
            setStatus(next); setReady(true); setNetwork('');
            if (next.memberId) {
              everJoined.current = true;
              if (!recorded) {
                await navigator.locks.request('meshrooms-recent', async () => {
                  const all = await read<RecentRoom[]>('recent-rooms') || [];
                  await write('recent-rooms', [{ id: urlRoom, title: next.title }, ...all.filter(r => r.id !== urlRoom)].slice(0, 64));
                });
                recorded = true;
              }
            }
            await engine.update(next);
            for (const signal of next.signals || []) cursor = Math.max(cursor, signal.seq);
          } catch (e) { if (!disposed) setNetwork((e as Error).message); }
          if (!disposed) await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, 1500); });
        }
      });
    })().catch(e => { if (!disposed) { setError(e.message); setReady(true); } });
    return () => { disposed = true; engine?.stop(); peers.current = null; clearTimeout(timer); wake?.(); };
  }, [api, retry]);
  useEffect(() => { if (admitted) scrollToLatest(); }, [admitted]);
  useEffect(() => { if (detailsOpen) detailsHeading.current?.focus(); }, [detailsOpen]);
  useEffect(() => {
    if (!admitted || !notice) return;
    const timeout = setTimeout(() => setNotice(''), 6000);
    return () => clearTimeout(timeout);
  }, [admitted, notice]);

  function scrollToLatest() {
    const scroller = transcript.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    setUnread(0);
  }
  function closeDetails() { setDetailsOpen(false); detailsButton.current?.focus(); }

  async function act(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  function create(event: FormEvent) {
    event.preventDefault();
    void act(async () => {
      // Persist the destination before submitting so a lost response can resume it.
      const previous = await read<{ id: string; name: string; title: string }>('pending-create');
      const operation = previous?.name === name && previous.title === title ? previous : { id: crypto.randomUUID(), name, title };
      await write('pending-create', operation); await write('display-name', name);
      try { await api.command('create', operation.id, { name, title, label: deviceLabel }); }
      catch (e) {
        const recovered = await api.command('status', operation.id, { session: crypto.randomUUID() }).catch(() => null);
        if (!recovered?.memberId) throw e;
      }
      await write('pending-create', null);
      location.assign(`/r/${operation.id}`);
    });
  }
  function request(kind: 'person' | 'companion') {
    void act(async () => {
      await api.command('request', urlRoom, { name: kind === 'person' ? name : 'Companion device', label: deviceLabel, kind });
      if (kind === 'person') await write('display-name', name);
      setNotice('Request sent.');
    });
  }
  const invite = `${location.origin}/r/${urlRoom}`;
  async function copyInvite() {
    try { await navigator.clipboard.writeText(invite); setNotice('Room link copied.'); }
    catch { setDetailsOpen(true); setNotice('Copy the room link from Room details.'); }
  }
  function send(event: FormEvent) {
    event.preventDefault(); const draft = text, replyTo = reply ? replyId : undefined;
    void act(async () => { if (!peers.current) throw new Error('Room connection is not ready.'); await peers.current.send(draft, replyTo); setText(''); setReplyId(undefined); });
  }
  function startReply(id: string) { setReplyId(id); requestAnimationFrame(() => composer.current?.focus()); }
  function connectAgent(event: FormEvent) {
    event.preventDefault(); const name = agentName.trim();
    void act(async () => {
      // The token is shown once; the room service keeps only its hash.
      const { token } = await api.command('agent-invite', urlRoom, { name }) as unknown as { token: string };
      setAgentLink({ name, url: `${location.origin}/agent/${urlRoom}#${token}` }); setAgentName('');
    });
  }
  async function copyAgentLink() {
    if (!agentLink) return;
    try { await navigator.clipboard.writeText(agentLink.url); setNotice('Agent link copied. Give it to your agent.'); }
    catch { setNotice('Select the agent link and copy it.'); }
  }
  /** Removes every device of a member; this device goes last so leaving still reports its result. Their agents leave with them. */
  function removeMember(member: BrowserMember) {
    void act(async () => {
      const devices = (status?.devices?.filter(d => d.memberId === member.id) || []).sort((a, b) => Number(a.id === status?.deviceId) - Number(b.id === status?.deviceId));
      for (const device of devices) await api.command('remove', urlRoom, { deviceId: device.id });
      setConfirming(undefined);
      setNotice(member.id === status?.memberId ? 'You left this room.' : `${member.name} was removed from the room.`);
    });
  }
  const agentsOf = (member: BrowserMember) => status?.members?.filter(m => isAgent(m) && m.operatorId === member.id).length || 0;
  /** Inline confirmation for removing a person or leaving, naming the agents that go with them. */
  function confirmRemove(member: BrowserMember) {
    const leaving = member.id === status?.memberId, count = agentsOf(member);
    const agentsText = `${count} agent${count === 1 ? '' : 's'}`;
    return <div className="browser-confirm" role="group" aria-label={leaving ? 'Confirm leaving the room' : `Confirm removing ${member.name}`}>
      <p>{leaving ? `Leave this room on all your devices${count ? ` and remove your ${agentsText}` : ''}?` : `Remove ${member.name}${count ? ` and their ${agentsText}` : ''} from this room?`}</p>
      <div><button className="secondary" disabled={busy} onClick={() => removeMember(member)}>{leaving ? 'Leave room' : 'Remove'}</button><button className="browser-text-link" onClick={() => setConfirming(undefined)}>Cancel</button></div>
    </div>;
  }

  return <div className={`browser-rooms ${admitted ? 'browser-joined' : ''}`}>
    <a className="skip-link" href="#browser-main">Skip to room</a>
    <aside className="browser-rail">
      <a className="browser-brand" href="/rooms" aria-label="Meshrooms rooms"><Wordmark demo={false} /></a>
      {admitted ? <>
        <nav className="browser-room-nav" aria-label="Your rooms"><h2>Your rooms</h2>
          {[{ id: urlRoom, title }, ...recent.filter(r => r.id !== urlRoom)].map(r => <a key={r.id} href={`/r/${r.id}`} aria-current={r.id === urlRoom ? 'page' : undefined}><RoomIcon kind="chat" /><span>{r.title}</span></a>)}
          <a href="/rooms" className="browser-all-rooms">Create a room</a>
        </nav>
        <a href="/rooms" className="browser-mobile-rooms">Your rooms</a>
        <div className="browser-self"><span className="avatar" aria-hidden="true">{self?.name.slice(0, 1)}</span><div><strong>{self?.name}</strong><span>{host ? 'Room host' : 'Room member'}</span></div></div>
      </> : <p className="browser-rail-intro">A shared room for your people and their agents.</p>}
      <p className="browser-rail-footer">Meshrooms by WormDB<br />Browser preview</p>
    </aside>
    <main id="browser-main" className={`browser-main ${detailsOpen ? 'browser-details-open' : ''}`} tabIndex={-1}>
      {error && <div role="alert" className="browser-error">{error} <button onClick={() => { setError(''); if (!status) setRetry(v => v + 1); }}>{status ? 'Dismiss' : 'Retry'}</button></div>}
      {network && <p role="status" className="browser-error">{network}</p>}
      {notice && <p role="status" className="browser-notice">{notice}</p>}
      {!ready ? <section className="browser-entry" aria-busy="true"><h1>Opening your room…</h1><p>Restoring this browser’s identity.</p></section> : !urlRoom ?
        <section className="browser-entry"><h1>Start a room</h1><p>Share a link. Approve who joins. Start talking.</p>
          <form onSubmit={create} className="browser-form"><label>Your name<input autoComplete="name" value={name} onChange={e => setName(e.target.value)} required maxLength={80} /></label>
            <label>Room name<input value={title} onChange={e => setTitle(e.target.value)} required maxLength={80} placeholder="Project room" /></label>
            <button className="primary" disabled={busy}>{busy ? 'Creating room…' : 'Create room'}</button></form>
          {recent.length > 0 && <section className="browser-recent"><h2>Your rooms</h2>{recent.map(r => <a key={r.id} href={`/r/${r.id}`}>{r.title}</a>)}</section>}
        </section> : !admitted ?
        <section className="browser-entry"><h1>{title || 'Join room'}</h1>
          {pending ? <>
            <h2>{status.request!.kind === 'companion' && !status.request!.linkedMemberId ? 'Confirm on your other device' : status.hostOnline ? 'Waiting for approval' : 'Waiting for the host to return'}</h2>
            {status.request!.kind === 'companion' && !status.request!.linkedMemberId ? <><p>In this room on your trusted device, open <strong>Room details</strong>, then <strong>Add another device</strong>, and enter this code.</p><code className="browser-link-code">{status.request!.code}</code><p>This request expires in ten minutes.</p></> : <p>You’ll enter the conversation when the host admits you.</p>}
            <div className="browser-entry-actions"><button className="secondary" disabled={busy} onClick={() => void act(async () => { await api.command('cancel', urlRoom, { requestId: status.request!.id }); setNotice('Join request canceled.'); })}>Cancel request</button>
              <a className="browser-text-link" href="/rooms">Back to your rooms</a></div>
          </> : <>
            <p>{status?.request?.state === 'expired' ? 'Your request expired. Ask to join again when you’re ready.' : everJoined.current ? 'This device no longer has access. Ask the host to admit it again.' : status?.request?.state === 'declined' ? 'The host declined your request.' : 'The host will approve your request before you enter.'}</p>
            <form className="browser-form" onSubmit={e => { e.preventDefault(); request('person'); }}><label>Your name<input autoComplete="name" value={name} onChange={e => setName(e.target.value)} required maxLength={80} /></label>
              <button className="primary" disabled={busy || !status}>{busy ? 'Sending request…' : 'Ask to join'}</button></form>
            <button className="browser-text-link" disabled={busy || !status} onClick={() => request('companion')}>Use my existing identity</button>
            <p className="browser-entry-note">No installation or agent needed. This browser remembers your identity.</p>
          </>}
        </section> : <>
          <header className="browser-room-header">
            <div className="browser-room-heading"><h1>{title}</h1><p>{people} {people === 1 ? 'person' : 'people'}{agents.length ? ` and ${agents.length} agent${agents.length === 1 ? '' : 's'}` : ''} in this room</p></div>
            <div className="browser-room-actions"><button className="secondary" ref={detailsButton} aria-expanded={detailsOpen} aria-controls="browser-room-details" onClick={() => detailsOpen ? closeDetails() : setDetailsOpen(true)}><RoomIcon kind="people" />Room details</button><button className="primary" onClick={() => void copyInvite()}><RoomIcon kind="link" />Copy room link</button></div>
          </header>
          <p className="sr-only" role="status">{host && status.requests?.length ? `${status.requests.length} request${status.requests.length === 1 ? '' : 's'} waiting to join. Use the join requests section to admit or decline.` : ''}</p>
          {host && !!status.requests?.length && <section className="browser-requests" aria-label="Join requests"><h2>Waiting to join <span>{status.requests.length}</span></h2>
            {status.requests.map(r => <div className="browser-request" key={r.id}><div><strong>{r.linkedMemberId ? status.members!.find(m => m.id === r.linkedMemberId)?.name : r.name}</strong><span>{r.kind === 'person' ? 'New person' : r.linkedMemberId ? 'Confirmed companion device' : 'Waiting for identity confirmation'} · {r.device.label}</span></div>
              <div className="browser-request-actions"><button disabled={busy} onClick={() => void act(async () => { await api.command('decide', urlRoom, { requestId: r.id, admit: false }); })}>Decline</button>
                {(r.kind === 'person' || r.linkedMemberId) && <button className="primary" disabled={busy} onClick={() => void act(async () => { await api.command('decide', urlRoom, { requestId: r.id, admit: true }); })}>Admit</button>}</div></div>)}
          </section>}
          <p className="sr-only" aria-live="polite" aria-atomic="true">{liveMessage && <span key={liveMessage.id}>{liveMessage.text}</span>}</p>
          <div className="browser-workspace">
            <div className="browser-conversation">
              <section ref={transcript} className="browser-transcript" role="log" aria-live="off" aria-label="Conversation" tabIndex={0} onScroll={e => { const el = e.currentTarget; if (el.scrollHeight - el.clientHeight - el.scrollTop < 100) setUnread(0); }}>
                <div className="browser-message-list">
                  {!messages.length && <div className="browser-empty"><RoomIcon kind="chat" /><h2>{status.members!.length > 1 ? 'Ready for your first message' : status.requests?.length ? 'Your conversation starts here' : 'Bring someone into the room'}</h2><p>{status.members!.length > 1 ? 'Send a message below to start the conversation.' : status.requests?.length ? 'Someone is waiting to join. Admit them above to get started.' : 'Share the room link with someone, or open it on another device.'}</p></div>}
                  {messages.map((m, index) => {
                    const body = m.packet.body;
                    const member = status.members!.find(p => p.id === body.memberId);
                    const author = member?.name || 'Former member';
                    const target = body.replyTo ? messages.find(t => t.packet.body.id === body.replyTo)?.packet.body : undefined;
                    const continuation = grouped(messages[index - 1], m) && !body.replyTo;
                    const next = messages[index + 1];
                    const own = body.deviceId === status.deviceId;
                    const showReceipt = own && (!next || !grouped(m, next) || m.receipts.length < m.targets.length);
                    const forYou = body.memberId !== status.memberId && (mentionedIds(body.text, participants).includes(status.memberId!) || target?.memberId === status.memberId);
                    const operator = operatorOf(member);
                    return <Fragment key={body.id}>
                      {(!index || !sameDay(messages[index - 1].packet.body.at, body.at)) && <div className="browser-day"><span>{dayLabel(body.at)}</span></div>}
                      <article className={`browser-message ${continuation ? 'browser-message-continuation' : ''} ${forYou ? 'browser-message-for-you' : ''} ${isAgent(member) ? 'browser-message-agent' : ''}`}>
                        <span className={`avatar ${isAgent(member) ? 'agent' : ''}`} aria-hidden="true">{author.slice(0, 1)}</span>
                        <div><header className={continuation ? 'sr-only' : ''}><strong>{author}</strong>{isAgent(member) && <span className="browser-role">agent</span>}{operator && <span className="browser-operator">for {operator}</span>}{body.memberId === status.memberId && <span className="browser-author-you">you</span>}<time dateTime={new Date(body.at).toISOString()}>{new Date(body.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                          <button className="browser-reply-button" aria-label={`Reply to ${own ? 'your' : `${author}’s`} message`} title="Reply" onClick={() => startReply(body.id)}>Reply</button></header>
                          {body.replyTo && <p className="browser-reply-reference">{target ? <>Replying to <strong>{nameOf(target.memberId)}</strong>: {target.text.length > 120 ? `${target.text.slice(0, 120)}…` : target.text}</> : 'Replying to an earlier message'}</p>}
                          <p><MentionText text={body.text} participants={participants} viewerId={status.memberId} /></p>
                          {showReceipt && <span className="browser-receipt">{m.targets.length ? `Stored on ${m.receipts.length} of ${m.targets.length} devices` : 'Saved in this browser'}</span>}
                        </div>
                      </article>
                    </Fragment>;
                  })}
                </div>
              </section>
              <div className="browser-compose-area">
                {unread > 0 && <button className="secondary browser-unread" onClick={scrollToLatest}>Show {unread} new message{unread === 1 ? '' : 's'}</button>}
                {mentions.list}
                {reply && <div className="browser-reply-draft"><span>Replying to <strong>{reply.packet.body.memberId === status.memberId ? 'your message' : nameOf(reply.packet.body.memberId)}</strong></span><button className="browser-close" aria-label="Cancel reply" onClick={() => setReplyId(undefined)}><RoomIcon kind="close" /></button></div>}
                <form className="browser-composer" onSubmit={send}><label className="sr-only" htmlFor="browser-message">Message {title}</label><textarea ref={composer} id="browser-message" value={text} {...mentions.inputProps}
                  onChange={e => { setText(e.target.value); mentions.track(e.target.value, e.target.selectionStart); }} onSelect={e => mentions.track(e.currentTarget.value, e.currentTarget.selectionStart)} onBlur={mentions.close}
                  onKeyDown={e => { if (mentions.onKeyDown(e)) return; if (e.key === 'Escape' && reply) { setReplyId(undefined); return; } if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (text.trim() && !busy) send(e); } }}
                  maxLength={4000} rows={2} placeholder={agents.length ? `Message ${title} · type @ to ask an agent` : `Message ${title}`} /><div><span className="browser-key-hint">Enter to send · Shift + Enter for a new line</span><button className="primary" disabled={busy || !text.trim()}><span>Send</span><RoomIcon kind="send" /></button></div></form>
                <p className="browser-connection" role="status"><span className={`browser-connection-dot ${connected.length ? 'is-connected' : ''}`} aria-hidden="true" />{connected.length ? `Connected to ${connected.length} other device${connected.length === 1 ? '' : 's'}` : status.devices!.length > 1 ? 'Waiting for another device to connect' : 'You’re the first one here'}</p>
              </div>
            </div>
            <aside id="browser-room-details" className="browser-details" aria-label="Room details" hidden={!detailsOpen} onKeyDown={e => { if (e.key === 'Escape') closeDetails(); }}>
              <header className="browser-details-heading"><h2 tabIndex={-1} ref={detailsHeading}>Room details</h2><button className="browser-close" aria-label="Close room details" onClick={closeDetails}><RoomIcon kind="close" /></button></header>
              <section aria-label="People and agents in this room" className="browser-people"><h3>{agents.length ? 'People and agents' : 'People'} <span>{status.members!.length}</span></h3>
                {status.members!.map(member => {
                  const devices = status.devices!.filter(d => d.memberId === member.id).length;
                  // The host may remove anyone but themselves; an operator may remove their own agents.
                  const removable = member.id !== status.memberId && (host ? member.id !== status.ownerId : isAgent(member) && member.operatorId === status.memberId);
                  return <div className="browser-person" key={member.id}><span className={`avatar ${isAgent(member) ? 'agent' : ''}`} aria-hidden="true">{member.name.slice(0, 1)}</span><div><strong>{member.name}{member.id === status.memberId ? ' (you)' : ''}</strong>
                    <span>{isAgent(member) ? `Agent · operated by ${operatorOf(member)}` : `${member.id === status.ownerId ? 'Host · ' : ''}${devices} device${devices === 1 ? '' : 's'}`}</span>
                    {removable && (confirming === member.id ? confirmRemove(member) : <button className="browser-remove" disabled={busy} aria-label={`Remove ${member.name} from the room`} onClick={() => setConfirming(member.id)}>{isAgent(member) ? 'Remove agent' : 'Remove'}</button>)}</div></div>;
                })}
              </section>
              {!isAgent(self) && <section className="browser-agents"><h3>Your agents</h3><p>You’re connecting as <strong>{self?.name}</strong>: you’ll be the operator of any agent you connect here, and only you and the host can remove it. Use your own browser, not one an agent is driving.</p>
                {agentLink ? <div className="browser-agent-link"><p>Give this link to <strong>{agentLink.name}</strong>. It works once and expires in 15 minutes.</p><label className="sr-only" htmlFor="browser-agent-link">Agent link for {agentLink.name}</label><input id="browser-agent-link" readOnly value={agentLink.url} onFocus={e => e.target.select()} />
                  <div><button className="secondary" onClick={() => void copyAgentLink()}>Copy agent link</button><button className="browser-text-link" onClick={() => setAgentLink(undefined)}>Done</button></div></div>
                  : <form onSubmit={connectAgent}><label>Agent name<input value={agentName} onChange={e => setAgentName(e.target.value)} required maxLength={64} placeholder="Codex" autoComplete="off" /></label><button className="secondary" disabled={busy || !agentName.trim()}>Connect an agent</button></form>}
                {status.agentInvites?.map(i => <p className="browser-agent-waiting" key={i.name}>Waiting for <strong>{i.name}</strong> to connect · link expires at {new Date(i.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>)}
              </section>}
              <section className="browser-invite"><h3>Invite someone</h3><p>New people wait for the host’s approval.</p><label className="sr-only" htmlFor="browser-invite-link">Room invite link</label><input id="browser-invite-link" readOnly value={invite} onFocus={e => e.target.select()} /></section>
              <section className="browser-device-section"><h3>Your devices</h3><p>Join as yourself from another browser.</p>
                <details className="browser-link-device"><summary>Add another device</summary><p>Open this room link on your other device and choose <strong>Use my existing identity</strong>. Enter its code here.</p>
                  <form onSubmit={e => { e.preventDefault(); void act(async () => { await api.command('link', urlRoom, { code: code.trim().toLowerCase() }); setCode(''); setNotice(host ? 'Your device is approved.' : 'Identity confirmed. The host can now admit your device.'); }); }}><label>Device code<input value={code} onChange={e => setCode(e.target.value)} required maxLength={16} autoComplete="off" spellCheck={false} /></label><button className="secondary" disabled={busy || code.trim().length !== 16}>Approve my device</button></form>
                </details>
                <details className="browser-device-details"><summary>Manage your devices</summary>
                  {status.devices!.filter(d => d.memberId === status.memberId).map(d => <div key={d.id}><strong>{d.label} · {d.id.slice(-6).toUpperCase()}</strong><span>{d.id === status.deviceId ? 'This device' : connected.includes(d.id) ? 'Connected' : 'Offline'}</span>{d.id !== status.deviceId && <button className="browser-remove" aria-label={`Remove ${d.label} ${d.id.slice(-6).toUpperCase()}`} disabled={busy} onClick={() => void act(async () => { await api.command('remove', urlRoom, { deviceId: d.id }); })}>Remove device</button>}</div>)}
                </details>
                {!host && self && (confirming === self.id ? confirmRemove(self) : <button className="browser-remove browser-leave" disabled={busy} onClick={() => setConfirming(self.id)}>Leave this room</button>)}
              </section>
              <p className="browser-storage-note">Messages stay in participating browsers. Device receipts confirm storage, not that someone has read a message.</p>
            </aside>
          </div>
        </>}
    </main>
  </div>;
}
