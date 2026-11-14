// MOCK signaling. The backend dev replaces ONLY this file (e.g. with a WebSocket).
// Contract the app relies on:
//   signaling.join(me, onPeers, onMessage)  register + start receiving
//   signaling.leave()                       unregister
//   signaling.send(toId, type, data)        deliver a message to one peer
//   signaling.update(patch)                 change our own peer info, e.g. { busy: true, battery: 80 };
//                                           everyone's list is refreshed. Peer fields: id, name, role, busy, battery
// me / peer = { id, name, role }  with role 'pilot' | 'robot'
// onPeers(list)    -> full list of connected peers, called on every join/leave
// onMessage(msg)   -> { from, type, data }
// Message types used: request, accept, reject, offer, answer, ice, hangup

const channel = new BroadcastChannel('drone-signal'); // shared by every tab of this site
const peers = new Map();                              // id -> peer
let me = null;
let onPeers = () => {};
let onMessage = () => {};

const emit = () => onPeers([...peers.values()]);      // push the current list to the UI

channel.onmessage = ({ data: m }) => {
  if (m.type === 'hello') {                           // someone joined (or answered our hello)
    peers.set(m.peer.id, m.peer);
    if (me && !m.reply) channel.postMessage({ type: 'hello', reply: true, peer: me }); // introduce ourselves back
    emit();
  } else if (m.type === 'bye') {                      // someone left
    peers.delete(m.id);
    emit();
  } else if (me && m.to === me.id) {                  // a message addressed to us
    onMessage(m);
  }
};

export const signaling = {
  join(peer, peersCb, messageCb) {
    me = peer; onPeers = peersCb; onMessage = messageCb;
    channel.postMessage({ type: 'hello', peer });
  },
  leave() {
    if (me) channel.postMessage({ type: 'bye', id: me.id });
    me = null; peers.clear();
  },
  update(patch) {
    if (!me) return;
    me = { ...me, ...patch };                         // merge the new fields into our peer info
    channel.postMessage({ type: 'hello', reply: true, peer: me }); // others replace their copy and refresh
  },
  send(to, type, data) {
    // Browser objects (RTCSessionDescription, RTCIceCandidate) cannot be copied by BroadcastChannel.
    // Turning data into plain JSON mimics a real WebSocket, which also sends JSON text.
    const plain = data === undefined ? null : JSON.parse(JSON.stringify(data));
    channel.postMessage({ to, from: me.id, type, data: plain });
  },
};

window.addEventListener('beforeunload', () => signaling.leave()); // tell others when the tab closes