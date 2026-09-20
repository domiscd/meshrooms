import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Connection, Message, NodeSnapshot, Participant } from '../room';
import { createRoomTransport } from '../transport';

type IconName = 'arrow' | 'plus' | 'close' | 'file' | 'reply' | 'link' | 'room' | 'check' | 'chevron' | 'settings';
const paths: Record<IconName, ReactNode> = {
  arrow: <path d="M4 12h15M13 5l7 7-7 7" />,
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  file: <path d="M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h6" />,
  reply: <path d="m9 5-6 6 6 6M3 11h10a7 7 0 0 1 7 7" />,
  link: <path d="m10 13 4-4M8 15l-2 2a4 4 0 0 1-5-5l4-4a4 4 0 0 1 5 0M14 9l2-2a4 4 0 0 1 5 5l-4 4a4 4 0 0 1-5 0" />,
  room: <path d="M4 5h16v12H9l-5 4zM8 9h8M8 13h5" />,
  check: <path d="m5 12 4 4L19 6" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  settings: <><path d="M4 7h5m4 0h7M4 17h9m4 0h3" /><circle cx="11" cy="7" r="2" /><circle cx="15" cy="17" r="2" /></>,
};
function Icon({ name }: { name: IconName }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
export function Wordmark({ demo }: { demo: boolean }) {
  return <div className="wordmark"><svg viewBox="0 0 28 28" width="28" height="28" fill="none" aria-hidden="true"><path d="M5 8h8v8H5zM15 12h8v8h-8zM9 4h10v8M9 16v8h10v-4" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></svg>meshrooms<span className="proto-label">{demo ? 'demo' : 'local'}</span></div>;
}
function Avatar({ name, agent = false }: { name: string; agent?: boolean }) {
  return <span className={`avatar ${agent ? 'agent' : ''}`} aria-hidden="true">{agent ? <svg width="19" height="19" viewBox="0 0 20 20" fill="none"><path d="M6 4 2 10l4 6m8-12 4 6-4 6M11 3 9 17" stroke="currentColor" strokeWidth="1.7" /></svg> : name.slice(0, 1)}</span>;
}
function Participants({ participants, connection, demo }: { participants: Participant[]; connection: Connection; demo: boolean }) {
  return <section className="participants" aria-labelledby="participants-title"><div className="section-label"><h2 id="participants-title">In this room</h2><span>{participants.length}</span></div><ul>{participants.map(p => {
    const stale = p.state === 'local' && connection !== 'local';
    const absentAgent = p.role === 'agent' && p.state === 'local' && p.connected !== true;
    const presenceLabel = p.state === 'local' ? stale ? 'Local node state unknown' : p.role === 'agent' ? p.connected ? 'Agent connected' : p.detail : 'Local node room member' : p.state === 'example-offline' ? 'Example: offline' : 'Example: idle';
    return <li key={p.id}><Avatar name={p.name} agent={p.role === 'agent'} /><div className="participant-copy"><div className="participant-name">{p.name}<span className="role-label">{p.role}</span></div><span className="participant-detail">{stale ? 'Last seen · node offline' : p.detail}</span></div><span className={`presence ${stale || absentAgent ? 'example-offline' : p.state}`} aria-label={presenceLabel} /></li>;
  })}</ul><p className="roster-note">{demo && <>Example members are labeled.<br /></>}Browser tabs are views of this node.</p></section>;
}

type RoomView = {
  draft: string; replyId?: string; sharing: boolean; shareTitle: string; shareText: string;
  preview: boolean; sending: boolean; error: string; notice: string;
};
const emptyView = (): RoomView => ({ draft: '', sharing: false, shareTitle: '', shareText: '', preview: false, sending: false, error: '', notice: '' });
const initialRoom = () => new URLSearchParams(location.search).get('room') || '';

export function RoomPrototype({ onSettings, selectedRoomId, connectionRevision = 0 }: { onSettings?: () => void; selectedRoomId?: string; connectionRevision?: number }) {
  const [roomId, setRoomId] = useState(initialRoom);
  const [node, setNode] = useState<NodeSnapshot | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [views, setViews] = useState<Record<string, RoomView>>({});
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [mobileRoomsOpen, setMobileRoomsOpen] = useState(false);
  const [roomForm, setRoomForm] = useState<'create' | 'join' | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [newProject, setNewProject] = useState('');
  const [joinValue, setJoinValue] = useState('');
  const [formError, setFormError] = useState('');
  const [roomActionPending, setRoomActionPending] = useState(false);
  const demoRequested = useRef(new URLSearchParams(location.search).get('demo') === '1');
  const explicitRoomRequested = useRef(new URLSearchParams(location.search).has('room'));
  const [transport] = useState(() => createRoomTransport(demoRequested.current));
  const activeId = useRef(roomId);
  const counts = useRef<Record<string, number>>({});
  const knownNodeId = useRef('');
  const composer = useRef<HTMLTextAreaElement>(null);
  const shareInput = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const roomNameInput = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const previousVisible = useRef({ roomId, count: 0 });
  const activeRoom = node?.rooms.find(room => room.id === roomId);
  const availableRoom = node?.availableRooms.find(room => room.id === roomId);
  const demo = node ? node.backend === 'demo' : demoRequested.current;
  const durable = node?.storage === 'wormdb';
  const localService = demo ? 'Local demo node' : 'Local daemon';
  const memoryLabel = durable ? 'Saved locally' : node || demo ? 'Local memory' : 'Local storage';
  const storageNote = !node && !demo ? 'Connecting to local storage. MeshGuard is not connected.' : durable ? 'Rooms and messages persist in WormDB. MeshGuard is not connected.' : 'Memory only; resets on restart. MeshGuard and WormDB are not connected.';
  const roomTitle = activeRoom?.title || availableRoom?.title || (node ? roomId ? 'Room unavailable' : 'Your rooms' : 'Opening rooms…');
  const state = views[roomId] || emptyView();
  const messages = activeRoom?.messages || [];
  const reply = messages.find(message => message.id === state.replyId);
  const groups = [...new Set(node?.rooms.map(room => room.project) || [])];

  function updateView(id: string, update: Partial<RoomView> | ((current: RoomView) => RoomView)) {
    setViews(all => {
      const current = all[id] || emptyView();
      return { ...all, [id]: typeof update === 'function' ? update(current) : { ...current, ...update } };
    });
  }
  function selectRoom(id: string) {
    activeId.current = id; setRoomId(id); setUnread(current => ({ ...current, [id]: 0 }));
    setMobileRoomsOpen(false); setRoomForm(null); setFormError('');
    const url = new URL(location.href); url.searchParams.set('room', id); url.searchParams.delete('variant'); history.replaceState(null, '', url);
    if (matchMedia('(max-width: 760px)').matches) requestAnimationFrame(() => heading.current?.focus());
  }
  useEffect(() => { if (selectedRoomId && selectedRoomId !== activeId.current) selectRoom(selectedRoomId); }, [selectedRoomId]);
  useEffect(() => {
    const url = new URL(location.href); url.searchParams.delete('variant'); history.replaceState(null, '', url);
    return transport.connect(next => {
      if (!activeId.current && !explicitRoomRequested.current && next.rooms.length) selectRoom(next.rooms[0].id);
      const changedNode = knownNodeId.current !== next.nodeId;
      const increments: Record<string, number> = {};
      for (const room of next.rooms) {
        const previous = counts.current[room.id];
        if (!changedNode && previous !== undefined && room.id !== activeId.current && room.messages.length > previous) increments[room.id] = room.messages.length - previous;
      }
      counts.current = Object.fromEntries(next.rooms.map(room => [room.id, room.messages.length]));
      knownNodeId.current = next.nodeId;
      setUnread(current => changedNode ? {} : Object.fromEntries([...new Set([...Object.keys(current), ...Object.keys(increments)])].map(id => [id, id === activeId.current ? 0 : (current[id] || 0) + (increments[id] || 0)])));
      setNode(next);
    }, setConnection);
  }, [connectionRevision]);
  useEffect(() => {
    if (scroller.current && getComputedStyle(scroller.current).overflowY === 'auto') {
      if (previousVisible.current.roomId !== roomId) scroller.current.scrollTop = 0;
      else if (previousVisible.current.count > 0 && messages.length > previousVisible.current.count) scroller.current.scrollTop = scroller.current.scrollHeight;
    }
    previousVisible.current = { roomId, count: messages.length };
  }, [roomId, messages.length]);
  useEffect(() => { if (state.sharing && !state.preview) shareInput.current?.focus({ preventScroll: true }); }, [roomId, state.sharing]);
  useEffect(() => { if (roomForm) roomNameInput.current?.focus(); }, [roomForm]);
  useEffect(() => {
    if (!state.notice) return;
    const id = roomId; const timer = setTimeout(() => updateView(id, { notice: '' }), 4500);
    return () => clearTimeout(timer);
  }, [roomId, state.notice]);

  async function send(isShare = false) {
    if (!activeRoom || state.sending || connection !== 'local' || (!state.draft.trim() && !isShare)) return;
    const origin = roomId;
    const submitted = { ...state };
    updateView(origin, { sending: true, error: '', notice: '' });
    try {
      await transport.send(origin, { text: isShare ? '' : submitted.draft.trim(), replyTo: submitted.replyId, share: isShare ? { title: submitted.shareTitle.trim(), text: submitted.shareText } : undefined });
      // The response belongs to its originating room, even after a view switch.
      updateView(origin, current => ({
        ...current, sending: false, notice: durable ? 'Saved locally in this room.' : 'Added to this room’s local memory.',
        draft: !isShare && current.draft === submitted.draft ? '' : current.draft,
        replyId: current.replyId === submitted.replyId ? undefined : current.replyId,
        ...(isShare && current.shareTitle === submitted.shareTitle && current.shareText === submitted.shareText ? { sharing: false, preview: false, shareTitle: '', shareText: '' } : {}),
      }));
      if (activeId.current === origin) composer.current?.focus({ preventScroll: true });
    } catch (error) { updateView(origin, { sending: false, error: (error as Error).message }); }
  }
  async function copyInvite() {
    const origin = roomId;
    const url = new URL('/prototype/room', location.origin); url.searchParams.set('room', origin);
    if (demoRequested.current) url.searchParams.set('demo', '1');
    try { await navigator.clipboard.writeText(url.href); updateView(origin, { notice: 'Same-machine room link copied. It opens this node on this computer.' }); }
    catch { setJoinValue(url.href); setRoomForm('join'); setFormError('Select and copy this local link.'); }
  }
  function openRoomForm(mode: 'create' | 'join') { setRoomForm(mode); setFormError(''); setMobileRoomsOpen(false); }
  async function joinKnown(id: string) {
    setRoomActionPending(true); setFormError('');
    try {
      if (!demo && node?.rooms.some(room => room.id === id)) selectRoom(id);
      else if (!demo) setFormError('This room is not on this local daemon. Remote invitations are not connected.');
      else selectRoom(await transport.joinRoom(id));
    }
    catch (error) { setFormError((error as Error).message); }
    finally { setRoomActionPending(false); }
  }
  async function submitRoom(event: React.FormEvent) {
    event.preventDefault();
    if (roomForm === 'join') {
      let id = joinValue.trim();
      if (id.startsWith('http')) {
        try { const invite = new URL(id); if (invite.origin !== location.origin || (invite.searchParams.get('demo') === '1') !== demoRequested.current) throw new Error(); id = invite.searchParams.get('room') || ''; }
        catch { setFormError('Use a room ID or a link from this same local node.'); return; }
      }
      await joinKnown(id); return;
    }
    setRoomActionPending(true); setFormError('');
    try { selectRoom(await transport.createRoom({ title: newTitle, project: newProject })); setNewTitle(''); setNewProject(''); }
    catch (error) { setFormError((error as Error).message); }
    finally { setRoomActionPending(false); }
  }

  return <>
    <a className="skip-link" href="#message">Skip to message composer</a>
    <div className="room-layout">
      <aside className="room-rail">
        <div className="rail-heading"><Wordmark demo={demo} /><button className="mobile-rooms-button" aria-expanded={mobileRoomsOpen} aria-controls="room-navigation" onClick={() => setMobileRoomsOpen(!mobileRoomsOpen)}>Rooms<Icon name="chevron" /></button></div>
        <div className="rail-scroll">
          <nav id="room-navigation" className={`room-nav ${mobileRoomsOpen ? 'is-open' : ''}`} aria-label="Rooms">
            <div className="nav-heading"><h2>Your rooms</h2><button className="icon-button" aria-label="Add a room" onClick={() => openRoomForm('create')}><Icon name="plus" /></button></div>
            {groups.map(project => <section className="project-group" key={project}><h3>{project || 'Other rooms'}</h3>{node?.rooms.filter(room => room.project === project).map(room => {
              const draft = views[room.id]; const hasDraft = !!(draft?.draft || draft?.shareText || draft?.replyId);
              return <button key={room.id} className={`room-link ${room.id === roomId ? 'active' : ''}`} aria-current={room.id === roomId ? 'page' : undefined} onClick={() => selectRoom(room.id)}><Icon name="room" /><span className="room-link-copy"><span>{room.title}</span><small>{hasDraft ? 'Draft saved in this view' : room.sample ? 'Example room' : 'Joined on this node'}</small></span>{(unread[room.id] || 0) > 0 && <span className="unread" aria-label={`${unread[room.id]} unread messages`}>{unread[room.id]}</span>}</button>;
            })}</section>)}
            {!node && <p className="nav-loading">Connecting to local rooms…</p>}
            {node && !node.rooms.length && <p className="nav-loading">No rooms yet.</p>}
            <button className="join-room-link" onClick={() => openRoomForm('join')}><Icon name="link" />{demo ? 'Join a room' : 'Open room link'}</button>
            {!demo && onSettings && <button className="join-room-link settings-link" onClick={onSettings}><Icon name="settings" />Settings</button>}
          </nav>
          {activeRoom && <Participants participants={activeRoom.participants} connection={connection} demo={demo} />}
        </div>
        <div className="rail-bottom"><strong>{demo ? 'One local demo node' : 'One local daemon'}</strong><span>Rooms stay joined while you switch views.</span></div>
      </aside>
      <main className="main-room">
        <header className="room-header"><div className="room-heading"><span className="room-symbol"><Icon name="room" /></span><div><h1 ref={heading} tabIndex={-1}>{roomTitle}</h1><div className="room-subtitle">{activeRoom || availableRoom ? `${(activeRoom || availableRoom)?.project || 'Other rooms'} · ${activeRoom?.sample || availableRoom?.sample ? 'Example room' : 'Joined on this node'}` : 'Rooms on your local node'}</div></div></div><div className="room-actions"><span className={`connection-label ${connection}`}><span className={`presence ${connection === 'local' ? 'local' : 'example-offline'}`} />{connection === 'local' ? localService : connection === 'connecting' ? 'Connecting locally' : `${localService} offline`}</span><button className="secondary invite-button" onClick={copyInvite} disabled={!activeRoom}><Icon name="link" />{demo ? 'Invite' : 'Copy room link'}</button></div></header>
        <div className="demo-strip"><div className="demo-state-row"><span>{demo ? 'Demo' : 'Local only'}</span><span className={`connection-inline ${connection}`} role="status"><span className={`presence ${connection === 'local' ? 'local' : 'example-offline'}`} />{connection === 'local' ? `${localService} connected` : connection === 'connecting' ? 'Connecting locally' : `${localService} offline · retrying`}</span></div><p>{storageNote}</p></div>

        {roomForm && <section className="room-form" aria-labelledby="room-form-title"><div className="form-heading"><div><h2 id="room-form-title">{roomForm === 'create' ? 'Create a room' : demo ? 'Join a local room' : 'Open a local room'}</h2><p>{roomForm === 'create' ? `A separate conversation, registered on this ${demo ? 'demo node' : 'local daemon'}.` : demo ? 'Join an available example, or paste a link from this node.' : 'Open a room already registered on this daemon.'}</p></div><button className="icon-button" aria-label="Close room form" onClick={() => setRoomForm(null)}><Icon name="close" /></button></div><div className="form-tabs"><button aria-pressed={roomForm === 'create'} onClick={() => openRoomForm('create')}>Create room</button><button aria-pressed={roomForm === 'join'} onClick={() => openRoomForm('join')}>{demo ? 'Join room' : 'Open room'}</button></div>
          <form onSubmit={submitRoom}>{roomForm === 'create' ? <div className="create-fields"><label>Room name<input ref={roomNameInput} value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="e.g. API review" maxLength={64} required /></label><label>Project label <span>(optional)</span><input value={newProject} onChange={e => setNewProject(e.target.value)} placeholder="e.g. MeshGuard" maxLength={48} list="project-labels" /><datalist id="project-labels">{groups.filter(Boolean).map(project => <option key={project} value={project} />)}</datalist></label></div> : <label>Room ID or local link<input ref={roomNameInput} value={joinValue} onChange={e => setJoinValue(e.target.value)} placeholder="Paste a local room link…" maxLength={300} required /></label>}<div className="form-submit"><p>{roomForm === 'create' ? 'Project labels organize rooms; they do not grant membership.' : 'Local links open this same node. Remote invitations are not connected.'}</p><button className="primary" type="submit" disabled={connection !== 'local' || roomActionPending}>{roomActionPending ? 'Working…' : roomForm === 'create' ? 'Create and open' : demo ? 'Join and open' : 'Open room'}<Icon name="arrow" /></button></div></form>
          {demo && roomForm === 'join' && !!node?.availableRooms.length && <div className="available-rooms"><h3>Available example rooms</h3>{node.availableRooms.map(room => <button key={room.id} onClick={() => joinKnown(room.id)} disabled={roomActionPending || connection !== 'local'}><span>{room.title}<small>{room.project}</small></span><span>Join<Icon name="arrow" /></span></button>)}</div>}
          {formError && <p className="form-error" role="alert">{formError}</p>}
        </section>}

        {activeRoom && state.sharing && !roomForm && <section className="share-panel" aria-labelledby="share-heading"><div className="share-heading"><div><h2 id="share-heading">{state.preview ? 'Ready to share?' : 'Share an excerpt'}</h2><p>{state.preview ? `This excerpt will be shared with ${roomTitle}.` : 'Paste only the part you want this room to see.'}</p></div><button className="icon-button" aria-label="Cancel sharing" onClick={() => updateView(roomId, { sharing: false, preview: false })}><Icon name="close" /></button></div>{!state.preview ? <><label htmlFor="share-title">Source label</label><input ref={shareInput} id="share-title" value={state.shareTitle} onChange={e => updateView(roomId, { shareTitle: e.target.value })} placeholder="e.g. connection-notes.md" maxLength={100} /><label htmlFor="share-text">Selected excerpt</label><textarea id="share-text" value={state.shareText} onChange={e => updateView(roomId, { shareText: e.target.value })} placeholder="Paste the text to share…" maxLength={8000} rows={3} /><div className="share-controls"><span>No files or private context are read.</span><button className="primary" disabled={!state.shareTitle.trim() || !state.shareText.trim()} onClick={() => updateView(roomId, { preview: true })}>Preview share<Icon name="arrow" /></button></div></> : <><div className="share-preview"><div><Icon name="file" /><strong>{state.shareTitle.trim()}</strong><span>Excerpt</span></div><pre>{state.shareText}</pre></div><div className="share-controls"><button className="text-button" onClick={() => updateView(roomId, { preview: false })}>Edit excerpt</button><button className="primary" onClick={() => send(true)} disabled={state.sending || connection !== 'local'}>{state.sending ? 'Sharing…' : 'Share to room'}<Icon name="arrow" /></button></div></>}</section>}

        <section className="conversation" aria-label="Room conversation"><div className="conversation-toolbar"><span>Conversation</span><span className="memory-note">{memoryLabel}</span></div><div ref={scroller} className="message-scroll" role="log" aria-label="Messages" aria-live="polite">
          {messages.length > 0 && <div className="date-rule"><span>Room history · {durable ? 'saved locally' : 'memory only'}</span></div>}
          {!node && <div className="empty-state"><h2>{connection === 'disconnected' ? `${localService} unavailable` : 'Opening the local node…'}</h2><p>{connection === 'disconnected' ? 'This view will reconnect when the local node returns.' : 'Loading the rooms registered on this node.'}</p></div>}
          {node && !activeRoom && <div className="empty-state"><Icon name="room" /><h2>{demo && availableRoom ? 'This room is ready to join' : !roomId && !node.rooms.length ? 'Create your first room' : 'This room is not on the local node'}</h2><p>{demo && availableRoom ? 'Join it once on the node, then return whenever you need it.' : !roomId && !node.rooms.length ? 'Give the conversation a name. You can organize rooms with project labels.' : 'Choose a room from the list or create a new one. Remote invitations are not connected.'}</p><button className="primary" onClick={() => demo && availableRoom ? joinKnown(availableRoom.id) : openRoomForm('create')} disabled={connection !== 'local' || roomActionPending}>{demo && availableRoom ? 'Join this room' : 'Create a room'}</button>{formError && <p className="form-error" role="alert">{formError}</p>}</div>}
          {activeRoom && messages.length === 0 && <div className="empty-state"><Icon name="room" /><h2>Start the conversation</h2><p>This room has its own history and membership. Send a message or share a selected excerpt.</p></div>}
          {messages.map(message => {
            const target = messages.find(m => m.id === message.replyTo); const own = message.authorId === node?.localParticipantId;
            return <article className="message" key={message.id}><Avatar name={own ? 'You' : message.author} agent={message.role === 'agent'} /><div className="message-main"><div className="message-meta"><strong>{own ? 'You' : message.author}</strong><span className="role-label">{message.role}</span><time dateTime={message.time}>{new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time><span className="message-state">{message.sample ? 'Example' : durable ? 'Saved locally' : 'In local memory'}</span><button className="reply-button" aria-label={`Reply to ${own ? 'your' : message.author + '’s'} message`} title="Reply" onClick={() => { updateView(roomId, { replyId: message.id }); composer.current?.focus(); }}><Icon name="reply" /></button></div>{target && <div className="reply-reference"><Icon name="reply" /><span>{target.author}: {target.text || target.share?.title}</span></div>}{message.text && <p>{message.text}</p>}{message.share && <div className="shared-excerpt"><div className="excerpt-title"><Icon name="file" /><strong>{message.share.title}</strong><span>Shared excerpt</span></div><pre>{message.share.text}</pre></div>}</div></article>;
          })}
        </div>
        {activeRoom && <div className="composer-area">{reply && <div className="reply-draft"><Icon name="reply" /><span>Replying to <strong>{reply.authorId === node?.localParticipantId ? 'your message' : reply.author}</strong></span><button className="icon-button" aria-label="Cancel reply" onClick={() => updateView(roomId, { replyId: undefined })}><Icon name="close" /></button></div>}<form className="composer" onSubmit={e => { e.preventDefault(); send(); }}><label className="sr-only" htmlFor="message">Message {roomTitle}</label><textarea ref={composer} id="message" value={state.draft} onChange={e => updateView(roomId, { draft: e.target.value })} placeholder={`Message ${roomTitle}…`} maxLength={4000} rows={2} onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } }} /><div className="composer-tools"><button type="button" className="share-button" onClick={() => updateView(roomId, { sharing: true, error: '' })}><Icon name="plus" />Share excerpt</button><div><span className="keyboard-hint">Ctrl + Enter</span><button className="primary send-button" type="submit" disabled={!state.draft.trim() || state.sending || connection !== 'local'}>{state.sending ? 'Sending…' : 'Send'}<Icon name="arrow" /></button></div></div></form><p className="composer-note">Only what you send is shared with this room. Drafts stay in this browser view.</p></div>}
        </section>
      </main>
    </div>
    <div className="feedback" aria-live="polite">{state.notice && <p><Icon name="check" />{state.notice}</p>}{state.error && <p className="error" role="alert">{state.error}<button aria-label="Dismiss error" onClick={() => updateView(roomId, { error: '' })}><Icon name="close" /></button></p>}</div>
  </>;
}
