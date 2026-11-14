import { useCallback, useEffect, useRef, useState } from 'react';
import { signaling } from './signaling';
import { startTelemetry } from './telemetry';

// Which directions the pilot is pressing. Also the "stopped" state.
export const NO_CONTROLS = { forward: false, back: false, left: false, right: false };

// STUN lets browsers find their public address. Add a TURN server here for production.
const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

export function useSession(role) {
  // Who we are. Created once; the backend can assign a real id/name later.
  const [me] = useState(() => {
    const id = Math.random().toString(36).slice(2, 8);
    return { id, role, name: `${role}-${id}` };
  });

  const [allPeers, setAllPeers] = useState([]);   // everyone connected to the server
  const [status, setStatus] = useState('');       // "Waiting..." / "Rejected" text on the list page
  const [incoming, setIncoming] = useState(null); // peer asking to connect -> shows the popup
  const [connState, setConnState] = useState('idle'); // idle | connecting | connected
  const [other, setOther] = useState(null);       // peer we are connected to
  const [messages, setMessages] = useState([]);   // chat log over the data channel
  const [localStream, setLocalStream] = useState(null);   // robot: its own camera
  const [remoteStream, setRemoteStream] = useState(null); // pilot: the robot's video
  const [camError, setCamError] = useState('');   // why the camera failed, if it did
  const [controls, setControls] = useState(NO_CONTROLS); // robot: what the pilot is pressing right now
  const [localTelemetry, setLocalTelemetry] = useState(null);   // robot: its own latest reading { data, at }
  const [remoteTelemetry, setRemoteTelemetry] = useState(null); // pilot: reading received from the robot
  const [latency, setLatency] = useState(null);   // { now, avg } round-trip time in ms

  // Refs hold values that must not trigger re-renders or go stale inside callbacks.
  const pc = useRef(null);          // RTCPeerConnection
  const dc = useRef(null);          // RTCDataChannel
  const otherRef = useRef(null);    // same as `other`, readable inside callbacks
  const incomingRef = useRef(null); // same as `incoming`
  const queue = useRef(Promise.resolve()); // keeps signaling messages processed in order
  const camera = useRef(Promise.resolve(null)); // resolves to the camera stream (robot) or null
  const pingTimer = useRef(null);   // interval that sends a ping every second
  const samples = useRef([]);       // last few latency measurements, for the average
  const pendingIce = useRef([]);    // ICE candidates that arrived before the remote description
  const latest = useRef(null);      // robot: newest drone reading, sent to the pilot every second
  const controlsRef = useRef(NO_CONTROLS); // robot: pilot's current command, read by the telemetry source
  const telemetryTimer = useRef(null);     // robot: interval that sends telemetry

  // Tear down the WebRTC session and go back to the list.
  const close = useCallback(() => {
    pc.current?.close();
    pc.current = null;
    dc.current = null;
    otherRef.current = null;
    setOther(null);
    setConnState('idle');
    setMessages([]);
    setRemoteStream(null);                            // drop the old video
    clearInterval(pingTimer.current);                 // stop pinging
    clearInterval(telemetryTimer.current);            // stop sending telemetry
    setRemoteTelemetry(null);                         // pilot: forget the old robot's readings
    samples.current = [];
    pendingIce.current = [];
    setControls(NO_CONTROLS);                         // session over: robot must stop
    controlsRef.current = NO_CONTROLS;
    setLatency(null);
    setStatus('');                                    // clear old "Waiting..." text
  }, []);

  // Create the peer connection. offerer = the side that clicked Connect.
  const makePeer = useCallback(async (offerer) => {
    // Robot: wait for the camera, but at most 3 s so a pending permission prompt cannot block the connection.
    const cam = await Promise.race([camera.current, new Promise((resolve) => setTimeout(() => resolve(null), 3000))]);
    const conn = new RTCPeerConnection(ICE);
    pc.current = conn;
    const target = otherRef.current;

    // Send every network candidate to the other side through the server.
    conn.onicecandidate = (e) => e.candidate && signaling.send(target.id, 'ice', e.candidate);
    conn.onconnectionstatechange = () => {
      console.log('connection:', conn.connectionState);   // debugging: connecting / connected / failed
      if (pc.current === conn && conn.connectionState === 'failed') {
        close();
        setStatus('Connection failed: the two sides could not find a network path (ICE failed).');
      }
    };

    // Video: the robot sends its camera; a pilot that makes the offer asks to receive video.
    conn.ontrack = (e) => setRemoteStream(e.streams[0]);   // video arrived -> show it
    if (cam) cam.getTracks().forEach((t) => conn.addTrack(t, cam));
    else if (role === 'pilot' && offerer) conn.addTransceiver('video', { direction: 'recvonly' });

    // Data channel = low-latency pipe for control messages.
    // Every data-channel message is JSON: { type: 'chat' | 'ping' | 'pong', ... }
    const wire = (ch) => {
      dc.current = ch;
      const ping = () => {                            // send a timestamp; the other side echoes it back
        if (ch.readyState === 'open') ch.send(JSON.stringify({ type: 'ping', ts: performance.now() }));
      };
      ch.onopen = () => {
        setConnState('connected');
        ping();
        pingTimer.current = setInterval(ping, 1000);  // measure once per second
        if (role === 'robot') {                       // robot: send the drone's live condition every second
          const sendTelemetry = () => {
            if (latest.current && ch.readyState === 'open') {
              ch.send(JSON.stringify({ type: 'telemetry', data: latest.current }));
            }
          };
          sendTelemetry();
          telemetryTimer.current = setInterval(sendTelemetry, 1000);
        }
      };
      ch.onclose = () => { clearInterval(pingTimer.current); clearInterval(telemetryTimer.current); };
      ch.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }   // ignore anything that is not JSON
        if (m.type === 'ping') {
          ch.send(JSON.stringify({ type: 'pong', ts: m.ts })); // echo straight back
        } else if (m.type === 'pong') {
          const now = Math.round(performance.now() - m.ts);    // round trip = time since we sent it
          samples.current = [...samples.current, now].slice(-10); // keep the last 10
          const avg = Math.round(samples.current.reduce((a, b) => a + b, 0) / samples.current.length);
          setLatency({ now, avg });
        } else if (m.type === 'telemetry') {
          setRemoteTelemetry({ data: m.data, at: Date.now() }); // pilot: robot's live condition
        } else if (m.type === 'control') {
          const next = { ...NO_CONTROLS };
          for (const k of Object.keys(next)) next[k] = m.state?.[k] === true; // accept only known keys, true/false only
          controlsRef.current = next;                  // the telemetry source reads this
          setControls(next);
        } else if (m.type === 'chat') {
          setMessages((list) => [...list, { from: target.name, text: m.text }]);
        }
      };
    };
    if (offerer) wire(conn.createDataChannel('control'));
    else conn.ondatachannel = (e) => wire(e.channel);

    return conn;
  }, [close, role]);

  // Handle one signaling message from the server.
  const onSignal = useCallback(async (m) => {
    // Add the ICE candidates that arrived too early (before the remote description was set).
    const flushIce = async () => {
      const early = pendingIce.current;
      pendingIce.current = [];
      for (const c of early) {
        try { await pc.current.addIceCandidate(c); } catch (err) { console.warn('ICE candidate skipped', err); }
      }
    };
    console.log('signal:', m.type);                    // debugging: shows the handshake steps in the console
    if (m.type === 'request') {
      if (pc.current || incomingRef.current) return signaling.send(m.from, 'reject'); // busy
      incomingRef.current = m.data.from;
      setIncoming(m.data.from);                       // show the accept/reject popup
    } else if (m.type === 'reject') {
      setStatus(`${otherRef.current?.name} rejected the request.`);
      otherRef.current = null;
      setOther(null);
    } else if (m.type === 'accept') {
      setConnState('connecting');
      const conn = await makePeer(true);              // we asked, so we create the offer
      await conn.setLocalDescription(await conn.createOffer());
      signaling.send(otherRef.current.id, 'offer', conn.localDescription);
    } else if (m.type === 'offer') {
      if (!pc.current) return;                        // session already ended: ignore the late message
      await pc.current.setRemoteDescription(m.data);  // apply their offer
      await flushIce();                               // now the early candidates can be added
      await pc.current.setLocalDescription(await pc.current.createAnswer());
      signaling.send(otherRef.current.id, 'answer', pc.current.localDescription);
    } else if (m.type === 'answer') {
      if (!pc.current) return;                        // session already ended: ignore the late message
      await pc.current.setRemoteDescription(m.data);  // apply their answer
      await flushIce();
    } else if (m.type === 'ice') {
      if (!pc.current) return;                        // no session: ignore
      if (!pc.current.remoteDescription) {
        pendingIce.current.push(m.data);              // too early: keep it until the remote description is set
      } else {
        try { await pc.current.addIceCandidate(m.data); } catch (err) { console.warn('ICE candidate skipped', err); }
      }
    } else if (m.type === 'hangup') {
      close();                                        // other side ended the session
    }
  }, [makePeer, close]);

  // Robot only: open the camera once when entering the robot page, stop it when leaving.
  useEffect(() => {
    if (role !== 'robot') return;
    let cancelled = false;
    let stream = null;
    const ask = navigator.mediaDevices
      ? navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      : Promise.reject(new Error('Camera needs https or localhost'));
    camera.current = ask
      .then((s) => {
        if (cancelled) { s.getTracks().forEach((t) => t.stop()); return null; }
        stream = s;
        setLocalStream(s);                            // used for the preview
        return s;
      })
      .catch((err) => { setCamError(err.message); return null; }); // session still works without video
    return () => { cancelled = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [role]);

  // Join the server when the page opens, leave when it closes.
  useEffect(() => {
    signaling.join(me, (list) => {
      setAllPeers(list);
      // If the peer we are connected to disappears (tab closed or reloaded), end the session.
      if (otherRef.current && !list.some((p) => p.id === otherRef.current.id)) {
        close();
        setStatus('The other side disconnected.');
      }
    }, (m) => {
      queue.current = queue.current.then(() => onSignal(m)).catch((err) => {
        console.error(err);
        close();
        setStatus(`Connection error: ${err.message}`);
      });
    });
    return () => { signaling.leave(); close(); };
  }, [me, onSignal, close]);

  // Robot only: read the drone's live condition. The real feed replaces the mock in telemetry.js.
  useEffect(() => {
    if (role !== 'robot') return;
    let lastPresence = 0;
    return startTelemetry(() => controlsRef.current, (data) => {
      latest.current = data;
      setLocalTelemetry({ data, at: Date.now() });
      if (Date.now() - lastPresence > 5000) {          // every 5 s put the battery on the list others see
        lastPresence = Date.now();
        signaling.update({ battery: data.battery });
      }
    });
  }, [role]);

  // Tell the server whether we are free or in a session, so lists can show Online / Busy.
  useEffect(() => { signaling.update({ busy: connState !== 'idle' }); }, [connState]);

  // --- actions used by the UI ---
  const connect = (peer) => {                         // click on a peer in the list
    otherRef.current = peer;
    setOther(peer);
    setStatus(`Waiting for ${peer.name} to accept...`);
    signaling.send(peer.id, 'request', { from: me });
  };

  const respond = async (accepted) => {                     // Accept / Reject in the popup
    const from = incomingRef.current;
    incomingRef.current = null;
    setIncoming(null);
    if (!accepted) return signaling.send(from.id, 'reject');
    otherRef.current = from;
    setOther(from);
    setConnState('connecting');
    try {
      await makePeer(false);                          // ready to receive their offer
      signaling.send(from.id, 'accept');
    } catch (err) {                                   // could not start: tell the requester and go back
      console.error(err);
      signaling.send(from.id, 'reject');
      close();
      setStatus(`Could not start the session: ${err.message}`);
    }
  };

  const sendControl = useCallback((state) => {        // pilot: tell the robot which directions are pressed
    if (dc.current?.readyState === 'open') dc.current.send(JSON.stringify({ type: 'control', state }));
  }, []);

  const send = (text) => {                            // send a message over the data channel
    if (dc.current?.readyState !== 'open') return;
    dc.current.send(JSON.stringify({ type: 'chat', text })); // wrap chat text in the JSON envelope
    setMessages((m) => [...m, { from: 'me', text }]);
  };

  const hangup = () => {                              // Disconnect button
    if (otherRef.current) signaling.send(otherRef.current.id, 'hangup');
    close();
  };

  const telemetry = role === 'robot' ? localTelemetry : remoteTelemetry; // robot sees its own, pilot sees the robot's

  // Pilots only see robots, robots only see pilots.
  const peers = allPeers.filter((p) => p.role !== role);

  return { me, peers, status, incoming, connState, other, messages, localStream, remoteStream, camError, latency,
           connect, respond, send, hangup, controls, sendControl, telemetry };
}