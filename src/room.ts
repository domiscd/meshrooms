export type Role = 'human' | 'agent';
export type Share = { title: string; text: string };
export type Participant = {
  id: string;
  name: string;
  role: Role;
  state: 'local' | 'remote' | 'example-idle' | 'example-offline';
  peerKey?: string;
  detail: string;
  connected?: boolean;
};
export type Message = {
  id: string;
  authorId: string;
  author: string;
  role: Role;
  text: string;
  time: string;
  sample?: boolean;
  replyTo?: string;
  share?: Share;
};
export type RoomInfo = { id: string; title: string; project: string; sample: boolean };
export type RoomSnapshot = RoomInfo & { messages: Message[]; participants: Participant[]; paired?: boolean };
export type NodeSnapshot = {
  backend: 'demo' | 'local';
  storage: 'memory' | 'wormdb';
  nodeId: string;
  localParticipantId: string;
  rooms: RoomSnapshot[];
  availableRooms: RoomInfo[];
};
export type Draft = { text: string; replyTo?: string; share?: Share };
export type Connection = 'connecting' | 'local' | 'disconnected';

/** One browser view subscribes to the node; selecting a room changes no membership. */
export interface RoomTransport {
  connect(onSnapshot: (state: NodeSnapshot) => void, onConnection: (state: Connection) => void): () => void;
  send(roomId: string, draft: Draft): Promise<void>;
  createRoom(input: { title: string; project: string }): Promise<string>;
  joinRoom(roomId: string): Promise<string>;
}
