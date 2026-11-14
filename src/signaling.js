// Signaling client. The rest of the app only uses these four calls:
//   signaling.join(me, onPeers, onMessage)  register + start receiving
//   signaling.leave()                       unregister
//   signaling.send(toId, type, data)        deliver a message to one peer
//   signaling.update(patch)                 change our own peer info, e.g. { busy: true, battery: 80 }
// me / peer = { id, name, role, busy, battery } with role 'pilot' | 'robot'
// onPeers(list) -> the OTHER peers online, called on every change. onMessage -> { from, type, data }.
// Message types used: request, accept, reject, offer, answer, ice, hangup
//
// Two implementations behind the same calls:
//   VITE_SIGNAL_URL set (e.g. ws://localhost:8080) -> real WebSocket server (see the backend repo)
//   not set                                        -> in-browser mock, so two tabs can still talk locally

const SIGNAL_URL = import.meta.env.VITE_SIGNAL_URL;

/* ---------------------------------------------------------------- WebSocket */
function createWebSocket(url) {
  let ws = null;
  let me = null;
  let onPeers = () => {};
  let onMessage = () => {};
  const waiting = [];                                   // messages sent before the socket was open

  // Send JSON now, or keep it until the socket opens.
  const raw = (obj) => {
    const text = JSON.stringify(obj);                   // RTCSessionDescription / RTCIceCandidate become plain JSON here
    if (ws?.readyState === WebSocket.OPEN) ws.send(text);
    else waiting.push(text);
  };

  const connect = () => {
    const socket = new WebSocket(url);
    ws = socket;
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'join', peer: me })); // register first
      waiting.splice(0).forEach((t) => socket.send(t));        // then send what was waiting
    };
    socket.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'peers') onPeers(m.peers.filter((p) => p.id !== me?.id)); // the server list includes us: hide self
      else if (m.type === 'signal') onMessage({ from: m.from, type: m.kind, data: m.data });
    };
    socket.onclose = () => {
      waiting.length = 0;   // old queued messages are stale now
      if (me && ws === socket) onPeers([]);     // server lost: we no longer know who is online, clear the list
      if (me && ws === socket) setTimeout(() => { if (me && ws === socket) connect(); }, 2000); // lost: retry in 2 s
    };
  };

  return {
    join(peer, peersCb, messageCb) { me = peer; onPeers = peersCb; onMessage = messageCb; connect(); },
    leave() { me = null; const s = ws; ws = null; waiting.length = 0; s?.close(); },
    update(patch) { if (!me) return; me = { ...me, ...patch }; raw({ type: 'update', patch }); },
    send(to, type, data) { raw({ type: 'signal', to, kind: type, data }); },
  };
}

/* --------------------------------------------------------------------- Mock */
function createMock() {
  const channel = new BroadcastChannel('drone-signal'); // shared by every tab of this site
  const peers = new Map();                              // id -> peer
  let me = null;
  let onPeers = () => {};
  let onMessage = () => {};

  const emit = () => onPeers([...peers.values()]);      // push the current list to the UI

  channel.onmessage = ({ data: m }) => {
    if (m.type === 'hello') {                           // someone joined, updated, or answered our hello
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

  window.addEventListener('beforeunload', () => { if (me) channel.postMessage({ type: 'bye', id: me.id }); });

  return {
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
      // Browser objects cannot be copied by BroadcastChannel; plain JSON mimics a real WebSocket.
      const plain = data === undefined ? null : JSON.parse(JSON.stringify(data));
      channel.postMessage({ to, from: me.id, type, data: plain });
    },
  };
}

export const signaling = SIGNAL_URL ? createWebSocket(SIGNAL_URL) : createMock();