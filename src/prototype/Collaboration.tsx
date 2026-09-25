import { Fragment, useMemo, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { AGENTS_MENTION, TASK_STATUSES, mentionSegments, type Floor, type Task, type TaskStatus } from '../collab';
import { parseMarkdown, type Block, type Inline } from '../markdown';
import type { Attachment, Participant, RoomSnapshot, TaskDraft } from '../room';

const statusLabels: Record<TaskStatus, string> = { todo: 'To do', doing: 'In progress', done: 'Done' };

/** Message markdown with @mentions marked; mentions of the viewer are stronger. Code stays literal. */
export function MentionText({ text, participants, viewerId }: { text: string; participants: Participant[]; viewerId?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const viewer = participants.find(p => p.id === viewerId)?.name.toLowerCase();
  const mentions = (value: string) => mentionSegments(value, participants).map((segment, index) => segment.mention
    ? <span key={index} className={`mention ${segment.text.slice(1).toLowerCase() === viewer ? 'you' : ''}`}>{segment.text}</span>
    : segment.text);
  const inline = (nodes: Inline[]): ReactNode[] => nodes.map((node, key) => {
    switch (node.type) {
      case 'text': return <Fragment key={key}>{mentions(node.text)}</Fragment>;
      case 'strong': return <strong key={key}>{inline(node.children)}</strong>;
      case 'em': return <em key={key}>{inline(node.children)}</em>;
      case 'code': return <code key={key}>{node.text}</code>;
      case 'link': return <a key={key} href={node.href} target="_blank" rel="noopener noreferrer">{inline(node.children)}</a>;
      case 'br': return <br key={key} />;
    }
  });
  const block = (node: Block, key: number): ReactNode => {
    switch (node.type) {
      case 'paragraph': return <p key={key}>{inline(node.children)}</p>;
      case 'heading': return <p key={key} className="md-heading"><strong>{inline(node.children)}</strong></p>;
      case 'code': return <figure key={key} className="md-code">{node.lang && <figcaption>{node.lang}</figcaption>}<pre><code>{node.text}</code></pre></figure>;
      case 'quote': return <blockquote key={key}>{node.children.map(block)}</blockquote>;
      case 'rule': return <hr key={key} />;
      case 'list': {
        // A leading paragraph stays inline so tight lists read like lists, not stacked paragraphs.
        const items = node.items.map((item, index) => <li key={index}>{item.map((child, at) => !at && child.type === 'paragraph' ? <Fragment key={at}>{inline(child.children)}</Fragment> : block(child, at))}</li>);
        return node.ordered ? <ol key={key} start={node.start === 1 ? undefined : node.start}>{items}</ol> : <ul key={key}>{items}</ul>;
      }
    }
  };
  return <>{blocks.map(block)}</>;
}

export function FloorControl({ floor, disabled, onChange }: { floor: Floor; disabled: boolean; onChange: (floor: Floor) => void }) {
  return <div className="floor-control" role="group" aria-label="When agents reply">
    <span>Agents reply</span>
    <button aria-pressed={floor === 'humans-first'} disabled={disabled} onClick={() => floor !== 'humans-first' && onChange('humans-first')}>When mentioned</button>
    <button aria-pressed={floor === 'open'} disabled={disabled} onClick={() => floor !== 'open' && onChange('open')}>To every message</button>
  </div>;
}

export function floorNote(floor: Floor | undefined, hasAgents: boolean) {
  if (!hasAgents || !floor) return 'Only what you send is shared with this room. Drafts stay in this browser view.';
  return floor === 'humans-first'
    ? 'Agents are listening. They reply only when you @mention them, write @agents, reply to them, or assign them a task.'
    : 'Open floor: agents may reply to every message from a person. @mention to direct a request.';
}

export type MentionOption = { key: string; label: string; detail: string; agent: boolean };
type MentionState = { start: number; query: string; active: number } | null;

/** @-autocomplete for the composer textarea. The caller owns the draft text. */
export function useMentions(participants: Participant[], viewerId: string | undefined, input: RefObject<HTMLTextAreaElement | null>, setDraft: (text: string) => void) {
  const [state, setState] = useState<MentionState>(null);
  const agents = participants.filter(p => p.role === 'agent');
  const options: MentionOption[] = [
    ...participants.filter(p => p.id !== viewerId).sort((a, b) => a.role === b.role ? 0 : a.role === 'agent' ? -1 : 1)
      .map(p => {
        const operator = participants.find(o => o.id === p.operatorId);
        const detail = p.role === 'agent' ? operator ? `agent · ${operator.id === viewerId ? 'yours' : `${operator.name}'s`}` : 'agent' : p.machine ? `human · ${p.machine}` : 'human';
        return { key: p.id, label: p.name, detail, agent: p.role === 'agent' };
      }),
    ...(agents.length > 1 ? [{ key: AGENTS_MENTION, label: AGENTS_MENTION, detail: `all ${agents.length} agents`, agent: true }] : []),
  ].filter(option => !state || option.label.toLowerCase().startsWith(state.query.toLowerCase()));
  const open = !!state && options.length > 0;

  function track(text: string, caret: number) {
    const before = text.slice(0, caret); const at = before.lastIndexOf('@');
    const query = at >= 0 ? before.slice(at + 1) : '';
    if (at < 0 || (at > 0 && /[\p{L}\p{N}_]/u.test(before[at - 1])) || query.length > 32 || /\n/.test(query)) { setState(null); return; }
    setState(current => ({ start: at, query, active: current?.start === at ? current.active : 0 }));
  }
  function choose(option: MentionOption) {
    const element = input.current; if (!element || !state) return;
    const insert = `@${option.label} `; const end = state.start + 1 + state.query.length;
    const text = element.value.slice(0, state.start) + insert + element.value.slice(end);
    setDraft(text); setState(null);
    requestAnimationFrame(() => { element.focus(); element.setSelectionRange(state.start + insert.length, state.start + insert.length); });
  }
  /** Returns true when the key was consumed by the suggestion list. */
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!open || !state) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); const step = event.key === 'ArrowDown' ? 1 : -1;
      setState({ ...state, active: (state.active + step + options.length) % options.length }); return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); choose(options[Math.min(state.active, options.length - 1)]); return true; }
    if (event.key === 'Escape') { event.preventDefault(); setState(null); return true; }
    return false;
  }
  function start() {
    const element = input.current; if (!element) return;
    const caret = element.selectionStart ?? element.value.length; const before = element.value.slice(0, caret);
    const text = before + (before && !/\s$/.test(before) ? ' @' : '@') + element.value.slice(caret);
    const next = caret + (text.length - element.value.length);
    setDraft(text); element.focus(); requestAnimationFrame(() => { element.setSelectionRange(next, next); track(text, next); });
  }
  const activeId = open ? `mention-option-${Math.min(state!.active, options.length - 1)}` : undefined;
  const list = open ? <ul className="mention-list" id="mention-list" role="listbox" aria-label="Mention someone">{options.map((option, index) =>
    <li key={option.key} id={`mention-option-${index}`} role="option" aria-selected={index === state!.active}
      onMouseDown={event => { event.preventDefault(); choose(option); }}>
      <span className={`mention-avatar ${option.agent ? 'agent' : ''}`} aria-hidden="true">{option.label.slice(0, 1).toUpperCase()}</span>
      <strong>@{option.label}</strong><span className="role-label">{option.detail}</span>
    </li>)}</ul> : null;
  return { track, onKeyDown, start, close: () => setState(null), list, inputProps: {
    role: 'combobox', 'aria-autocomplete': 'list' as const, 'aria-expanded': open, 'aria-controls': open ? 'mention-list' : undefined, 'aria-activedescendant': activeId,
  } };
}

type BoardActions = {
  create: (task: TaskDraft & { title: string }) => Promise<void>;
  update: (task: Task, changes: TaskDraft) => Promise<void>;
  remove: (task: Task) => Promise<void>;
};

export function TaskBoard({ room, viewerId, disabled, onClose, actions }: { room: RoomSnapshot; viewerId?: string; disabled: boolean; onClose: () => void; actions: BoardActions }) {
  const [title, setTitle] = useState(''); const [assignee, setAssignee] = useState(''); const [busy, setBusy] = useState(false);
  const tasks = room.tasks || []; const local = room.participants.filter(p => p.state === 'local');
  const open = tasks.filter(t => t.status !== 'done').length;
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (!title.trim() || busy) return; setBusy(true);
    try { await actions.create({ title: title.trim(), assigneeId: assignee || undefined }); setTitle(''); setAssignee(''); }
    catch { /* The room view reports the error; keep the draft for a retry. */ }
    finally { setBusy(false); }
  }
  return <aside className="task-board" id="task-board" aria-labelledby="task-board-title">
    <div className="board-heading"><div><h2 id="task-board-title">Tasks</h2><p>{open} open · {room.paired ? 'On this machine only; the paired node does not see this board.' : 'Everyone in this room can add, assign, and move tasks.'}</p></div>
      <button className="icon-button" aria-label="Close tasks" onClick={onClose}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg></button></div>
    <form className="task-add" onSubmit={submit}>
      <label className="sr-only" htmlFor="task-title">New task</label>
      <input id="task-title" value={title} onChange={e => setTitle(e.target.value)} placeholder="Add a task…" maxLength={120} />
      <div><label className="sr-only" htmlFor="task-assignee">Assign to</label>
        <select id="task-assignee" value={assignee} onChange={e => setAssignee(e.target.value)}><option value="">Unassigned</option>{local.map(p => <option key={p.id} value={p.id}>{p.id === viewerId ? `${p.name} (you)` : p.name}{p.role === 'agent' ? ' · agent' : ''}</option>)}</select>
        <button className="primary" type="submit" disabled={disabled || busy || !title.trim()}>{busy ? 'Adding…' : 'Add'}</button></div>
    </form>
    <div className="board-columns">{TASK_STATUSES.map(status => {
      const items = tasks.filter(t => t.status === status);
      return <section key={status} className={`board-column ${status}`} aria-labelledby={`board-${status}`}>
        <h3 id={`board-${status}`}>{statusLabels[status]}<span>{items.length}</span></h3>
        {items.length === 0 ? <p className="board-empty">{status === 'todo' ? 'Nothing waiting.' : status === 'doing' ? 'Nobody is working on a task.' : 'No finished tasks yet.'}</p>
          : <ul>{items.map(task => <TaskCard key={task.id} task={task} room={room} viewerId={viewerId} disabled={disabled} actions={actions} />)}</ul>}
      </section>;
    })}</div>
  </aside>;
}

function TaskCard({ task, room, viewerId, disabled, actions }: { task: Task; room: RoomSnapshot; viewerId?: string; disabled: boolean; actions: BoardActions }) {
  const [expanded, setExpanded] = useState(false); const [notes, setNotes] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const name = (id?: string) => id === viewerId ? 'You' : room.participants.find(p => p.id === id)?.name || 'Former member';
  const assignee = room.participants.find(p => p.id === task.assigneeId);
  const local = room.participants.filter(p => p.state === 'local');
  async function run(action: () => Promise<void>) { setBusy(true); try { await action(); } catch { /* Reported by the room view. */ } finally { setBusy(false); } }
  const next: TaskStatus | undefined = task.status === 'todo' ? 'doing' : task.status === 'doing' ? 'done' : undefined;
  const lock = disabled || busy;
  return <li className="task-card">
    <div className="task-top">
      <button className="task-title" aria-expanded={expanded} onClick={() => { setExpanded(!expanded); setNotes(null); }}>{task.title}</button>
      {next ? <button className="task-advance" disabled={lock} onClick={() => run(() => actions.update(task, { status: next }))}>{next === 'doing' ? 'Start' : 'Done'}</button>
        : <button className="task-advance" disabled={lock} onClick={() => run(() => actions.update(task, { status: 'todo' }))}>Reopen</button>}
    </div>
    <div className="task-meta">
      {assignee ? <span className={`task-assignee ${assignee.role}`}>{assignee.id === viewerId ? 'You' : assignee.name}{assignee.role === 'agent' && <span className="role-label">agent</span>}</span> : <span className="task-assignee none">Unassigned</span>}
      {task.notes && !expanded && <span className="task-has-notes">Notes</span>}
    </div>
    {expanded && <div className="task-details">
      <label>Assignee<select value={task.assigneeId || ''} disabled={lock} onChange={e => run(() => actions.update(task, { assigneeId: e.target.value || null }))}><option value="">Unassigned</option>{local.map(p => <option key={p.id} value={p.id}>{p.id === viewerId ? `${p.name} (you)` : p.name}{p.role === 'agent' ? ' · agent' : ''}</option>)}</select></label>
      <label>Status<select value={task.status} disabled={lock} onChange={e => run(() => actions.update(task, { status: e.target.value as TaskStatus }))}>{TASK_STATUSES.map(s => <option key={s} value={s}>{statusLabels[s]}</option>)}</select></label>
      <label>Notes<textarea value={notes ?? task.notes} onChange={e => setNotes(e.target.value)} maxLength={2000} rows={3} placeholder="Acceptance criteria, branch, links…" /></label>
      <div className="task-actions">
        <button className="text-button danger" disabled={lock} onClick={() => run(() => actions.remove(task))}>Remove</button>
        <button className="secondary" disabled={lock || notes === null || notes === task.notes} onClick={() => run(async () => { await actions.update(task, { notes: notes ?? '' }); setNotes(null); })}>Save notes</button>
      </div>
      <p className="task-history">Added by {name(task.createdBy)} · updated by {name(task.updatedBy)} {new Date(task.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
    </div>}
  </li>;
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_MESSAGE_FILES = 4;
export type PendingFile = { key: string; file: File; name: string; preview?: string; status: 'uploading' | 'ready' | 'failed'; attachment?: Attachment; error?: string };

export function formatBytes(size: number) {
  return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${Math.round(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
}
/** Clipboard screenshots arrive as "image.png"; give them a name that says what and when. */
export function uploadName(file: File) {
  if (file.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(file.name)) return file.name;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  return `screenshot-${stamp}.${file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'}`;
}
export const attachmentUrl = (roomId: string, id: string) => `/api/node/attachments/${roomId}/${id}`;

function FileIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3H5v18h14V8zM14 3v5h5" /></svg>;
}

export function PendingFiles({ files, onRemove, onRetry }: { files: PendingFile[]; onRemove: (key: string) => void; onRetry: (key: string) => void }) {
  if (!files.length) return null;
  return <ul className="pending-files" aria-label="Attachments for this message">{files.map(item => <li key={item.key} className={`pending-file ${item.status}`}>
    {item.preview ? <img src={item.preview} alt="" /> : <span className="pending-icon"><FileIcon /></span>}
    <span className="pending-copy"><strong>{item.name}</strong><span role="status">{item.status === 'uploading' ? 'Uploading…' : item.status === 'failed' ? item.error || 'Upload failed' : formatBytes(item.file.size)}</span></span>
    {item.status === 'failed' && <button type="button" className="text-button" onClick={() => onRetry(item.key)}>Retry</button>}
    <button type="button" className="pending-remove" aria-label={`Remove ${item.name}`} onClick={() => onRemove(item.key)}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg></button>
  </li>)}</ul>;
}

/** Where an attachment's bytes are: a URL, or a note while they are not on this device yet (browser rooms fetch them from peers). */
export type AttachmentSource = (attachment: Attachment) => { url?: string; note?: string };

/** Images render inline and open full size; other files are downloads. */
export function MessageAttachments({ roomId, attachments, author, source }: { roomId: string; attachments: Attachment[]; author: string; source?: AttachmentSource }) {
  const [open, setOpen] = useState<Attachment | null>(null);
  const locate: AttachmentSource = source || (a => ({ url: attachmentUrl(roomId, a.id) }));
  const images = attachments.filter(a => a.kind === 'image'); const files = attachments.filter(a => a.kind !== 'image');
  const viewing = open && locate(open).url;
  return <div className="message-attachments">
    {images.length > 0 && <div className={`attachment-images count-${Math.min(images.length, 4)}`}>{images.map(image => {
      const { url, note } = locate(image);
      return url ? <button key={image.id} className="attachment-image" onClick={() => setOpen(image)} aria-label={`Open ${image.name} from ${author}`}>
        <img src={url} alt={image.name} width={image.width} height={image.height} loading="lazy" decoding="async" />
      </button> : <div key={image.id} className="attachment-image attachment-waiting" role="img" aria-label={`${image.name}: ${note}`} style={image.width && image.height ? { aspectRatio: `${image.width} / ${image.height}` } : undefined}>
        <span><strong>{image.name}</strong><small>{note}</small></span></div>;
    })}</div>}
    {files.map(file => {
      const { url, note } = locate(file);
      const label = <><FileIcon /><span><strong>{file.name}</strong><small>{note || `${file.type === 'application/pdf' ? 'PDF' : file.type === 'text/plain' ? 'Text' : 'File'} · ${formatBytes(file.size)}`}</small></span></>;
      return url ? <a key={file.id} className="attachment-file" href={url} download={file.name}>{label}</a> : <span key={file.id} className="attachment-file attachment-waiting">{label}</span>;
    })}
    {open && viewing && <ImageViewer url={viewing} image={open} author={author} onClose={() => setOpen(null)} />}
  </div>;
}

function ImageViewer({ url, image, author, onClose }: { url: string; image: Attachment; author: string; onClose: () => void }) {
  return <dialog className="image-viewer" aria-label={image.name} ref={element => { if (element && !element.open) element.showModal(); }}
    onClose={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="viewer-bar"><span><strong>{image.name}</strong><small>{author} · {image.width && image.height ? `${image.width}×${image.height} · ` : ''}{formatBytes(image.size)}</small></span>
      <a className="secondary" href={url} download={image.name}>Download</a>
      <button className="icon-button" aria-label="Close image" onClick={onClose} autoFocus><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg></button></div>
    <img src={url} alt={image.name} />
  </dialog>;
}
